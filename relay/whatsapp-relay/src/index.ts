// Hive WhatsApp relay: verifies Meta webhooks, keeps incoming messages for up to 24h,
// and lets your Hive app long-poll for them. Stores no outbound content.

export interface Env {
  INBOX: DurableObjectNamespace
  RELAY_SECRET: string
  VERIFY_TOKEN: string
  APP_SECRET: string
}

interface Incoming {
  seq: number
  receivedAt: number
  id: string
  from: string
  text: string
  buttonId?: string
  contextId?: string
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_KEEP = 500
const POLL_WAIT_MS = 25_000

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  if (ea.length !== eb.length) return false
  let diff = 0
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i]
  return diff === 0
}

async function validSignature(body: ArrayBuffer, header: string | null, secret: string): Promise<boolean> {
  if (!header?.startsWith('sha256=') || !secret) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, body))
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
  return timingSafeEqual(hex, header.slice(7))
}

/** Pulls the messages we care about out of a Cloud API webhook payload. */
function extract(payload: any): Omit<Incoming, 'seq' | 'receivedAt'>[] {
  const out: Omit<Incoming, 'seq' | 'receivedAt'>[] = []
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const m of change?.value?.messages ?? []) {
        let text = ''
        let buttonId: string | undefined
        if (m.type === 'text') text = m.text?.body ?? ''
        else if (m.type === 'interactive' && m.interactive?.button_reply) {
          buttonId = m.interactive.button_reply.id
          text = m.interactive.button_reply.title ?? ''
        } else if (m.type === 'button') text = m.button?.text ?? m.button?.payload ?? ''
        else continue // images, audio, etc. aren't supported yet
        out.push({ id: String(m.id), from: String(m.from), text, buttonId, contextId: m.context?.id })
      }
    }
  }
  return out
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const inbox = env.INBOX.get(env.INBOX.idFromName('default'))

    if (url.pathname === '/webhook' && req.method === 'GET') {
      const ok = url.searchParams.get('hub.mode') === 'subscribe' && timingSafeEqual(url.searchParams.get('hub.verify_token') ?? '', env.VERIFY_TOKEN ?? '')
      return ok ? new Response(url.searchParams.get('hub.challenge') ?? '') : new Response('forbidden', { status: 403 })
    }

    if (url.pathname === '/webhook' && req.method === 'POST') {
      const body = await req.arrayBuffer()
      if (!(await validSignature(body, req.headers.get('x-hub-signature-256'), env.APP_SECRET))) {
        return new Response('bad signature', { status: 401 })
      }
      const messages = extract(JSON.parse(new TextDecoder().decode(body)))
      if (messages.length) await inbox.fetch('https://inbox/push', { method: 'POST', body: JSON.stringify(messages) })
      return new Response('ok') // always 200 quickly so Meta doesn't retry
    }

    if (url.pathname === '/poll' && req.method === 'GET') {
      const auth = req.headers.get('authorization') ?? ''
      if (!env.RELAY_SECRET || !timingSafeEqual(auth, `Bearer ${env.RELAY_SECRET}`)) return new Response('unauthorized', { status: 401 })
      return inbox.fetch(`https://inbox/poll?after=${encodeURIComponent(url.searchParams.get('after') ?? '0')}`)
    }

    if (url.pathname === '/') return new Response('Hive WhatsApp relay is running.')
    return new Response('not found', { status: 404 })
  }
}

export class Inbox {
  private waiters = new Set<() => void>()

  constructor(private state: DurableObjectState) {}

  private async load(): Promise<{ seq: number; messages: Incoming[] }> {
    const seq = (await this.state.storage.get<number>('seq')) ?? 0
    const messages = (await this.state.storage.get<Incoming[]>('messages')) ?? []
    return { seq, messages }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === '/push') {
      const incoming = (await req.json()) as Omit<Incoming, 'seq' | 'receivedAt'>[]
      let { seq, messages } = await this.load()
      const seen = new Set(messages.map((m) => m.id)) // Meta can deliver the same webhook twice
      const now = Date.now()
      for (const m of incoming) {
        if (seen.has(m.id)) continue
        messages.push({ ...m, seq: ++seq, receivedAt: now })
      }
      messages = messages.filter((m) => now - m.receivedAt < MAX_AGE_MS).slice(-MAX_KEEP)
      await this.state.storage.put({ seq, messages })
      for (const w of this.waiters) w()
      this.waiters.clear()
      return new Response('ok')
    }

    if (url.pathname === '/poll') {
      const after = Number(url.searchParams.get('after') ?? 0) || 0
      const newer = async () => (await this.load()).messages.filter((m) => m.seq > after)
      let found = await newer()
      if (!found.length) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            this.waiters.delete(done)
            resolve()
          }
          const timer = setTimeout(done, POLL_WAIT_MS)
          this.waiters.add(done)
        })
        found = await newer()
      }
      const messages = found.map(({ seq, id, from, text, buttonId, contextId }) => ({ seq, id, from, text, buttonId, contextId }))
      return Response.json({ messages })
    }

    return new Response('not found', { status: 404 })
  }
}
