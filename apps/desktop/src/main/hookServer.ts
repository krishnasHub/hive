// Local HTTP endpoint that Claude Code's `type: "http"` hooks call. Bound to 127.0.0.1 with a per-launch token.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { HookPayload } from '@core/sessionState'

export interface HookRequest {
  sessionId: string
  event: string
  payload: HookPayload
  /** Resolves when the client disconnects (e.g. Claude Code gave up waiting). */
  onAbort(fn: () => void): void
}

/** Return the JSON Claude Code should see. May wait (used to hold permission prompts). */
export type HookHandler = (req: HookRequest) => Promise<unknown> | unknown

const MAX_BODY = 5 * 1024 * 1024

export class HookServer {
  readonly token = randomBytes(24).toString('hex')
  private server?: Server
  port = 0

  constructor(private handler: HookHandler) {}

  async start(): Promise<number> {
    this.server = createServer((req, res) => void this.handle(req, res))
    // Held permission prompts can stay open for hours.
    this.server.requestTimeout = 0
    this.server.headersTimeout = 30_000
    this.server.keepAliveTimeout = 5_000
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => resolve())
    })
    this.port = (this.server.address() as AddressInfo).port
    return this.port
  }

  stop() {
    this.server?.close()
    this.server?.closeAllConnections()
  }

  private authorized(req: IncomingMessage): boolean {
    const got = Buffer.from(String(req.headers.authorization ?? ''))
    const want = Buffer.from(`Bearer ${this.token}`)
    return got.length === want.length && timingSafeEqual(got, want)
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const send = (code: number, body: unknown) => {
      if (res.writableEnded || res.destroyed) return
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const m = /^\/hook\/([^/]+)\/([A-Za-z]+)$/.exec(req.url ?? '')
    if (req.method !== 'POST' || !m) return send(404, { error: 'not found' })
    if (!this.authorized(req)) return send(401, { error: 'unauthorized' })

    let size = 0
    const chunks: Buffer[] = []
    try {
      for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > MAX_BODY) return send(413, { error: 'too large' })
        chunks.push(chunk as Buffer)
      }
    } catch {
      return
    }
    let payload: HookPayload = {}
    try {
      payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    } catch {
      return send(400, { error: 'bad json' })
    }

    const abortFns: (() => void)[] = []
    res.on('close', () => {
      if (!res.writableEnded) for (const fn of abortFns) fn()
    })
    try {
      const out = await this.handler({
        sessionId: decodeURIComponent(m[1]),
        event: m[2],
        payload,
        onAbort: (fn) => abortFns.push(fn)
      })
      send(200, out ?? {})
    } catch (err) {
      console.error('[hive] hook handler failed', err)
      send(200, {}) // never break Claude because Hive had a problem
    }
  }
}
