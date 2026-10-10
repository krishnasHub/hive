// Runs inside an Electron utilityProcess, one per plugin. Loads the plugin and bridges it to the main process.
// Plugins only see the `ctx` object built here; they never get Electron or Hive internals.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

type Msg = Record<string, unknown> & { type: string }

interface ChannelImpl {
  send(message: unknown): Promise<{ threadRef?: string } | void> | { threadRef?: string } | void
  test?(): Promise<string | void> | string | void
  stop?(): Promise<void> | void
}

const port = process.parentPort
let channel: ChannelImpl | undefined
let deactivate: (() => unknown) | undefined

function post(msg: Msg) {
  port.postMessage(msg)
}

function fmt(args: unknown[]): string {
  return args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
}

async function init(m: Msg) {
  const dir = String(m.dir)
  const main = String(m.main)
  const dataDir = String(m.dataDir)
  const settings = (m.settings ?? {}) as Record<string, unknown>
  mkdirSync(dataDir, { recursive: true })
  const storeFile = join(dataDir, 'storage.json')
  let storage: Record<string, unknown> = {}
  try {
    if (existsSync(storeFile)) storage = JSON.parse(readFileSync(storeFile, 'utf8'))
  } catch {
    storage = {}
  }

  const log = {
    info: (...a: unknown[]) => post({ type: 'log', level: 'info', text: fmt(a) }),
    warn: (...a: unknown[]) => post({ type: 'log', level: 'warn', text: fmt(a) }),
    error: (...a: unknown[]) => post({ type: 'log', level: 'error', text: fmt(a) })
  }

  const ctx = {
    hiveApi: 1,
    settings: Object.freeze({ ...settings }),
    dataDir,
    log,
    storage: {
      get: (key: string) => storage[key],
      set: (key: string, value: unknown) => {
        storage[key] = value
        writeFileSync(storeFile, JSON.stringify(storage, null, 2))
      }
    },
    /** Report health shown in Settings → Notifications. */
    setStatus: (state: 'running' | 'error', message?: string) => post({ type: 'status', state, message }),
    channel: {
      register: (impl: ChannelImpl) => {
        channel = impl
      },
      /** Hand a reply from your phone to Hive. */
      reply: (r: { text: string; threadRef?: string; actionId?: string; from?: string }) =>
        post({ type: 'reply', reply: { text: String(r.text ?? ''), threadRef: r.threadRef, actionId: r.actionId, from: r.from } })
    }
  }

  const req = createRequire(join(dir, 'package.json'))
  const mod = req(join(dir, main))
  const plugin = mod?.default ?? mod
  if (typeof plugin.activate !== 'function') throw new Error(`${main} does not export activate(ctx)`)
  deactivate = plugin.deactivate
  await plugin.activate(ctx)
  post({ type: 'ready' })
}

port.on('message', async (e: { data: Msg }) => {
  const m = e.data
  try {
    switch (m.type) {
      case 'init':
        await init(m)
        break
      case 'send': {
        if (!channel) throw new Error('Plugin did not register a channel')
        const r = await channel.send(m.message)
        post({ type: 'result', id: m.id, ok: true, value: r ?? {} })
        break
      }
      case 'test': {
        if (!channel) throw new Error('Plugin did not register a channel')
        const r = channel.test ? await channel.test() : undefined
        post({ type: 'result', id: m.id, ok: true, value: r ?? 'OK' })
        break
      }
      case 'stop':
        try {
          await channel?.stop?.()
          await deactivate?.()
        } finally {
          process.exit(0)
        }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (m.id) post({ type: 'result', id: m.id, ok: false, error: message })
    else post({ type: 'status', state: 'error', message })
  }
})

process.on('uncaughtException', (err) => post({ type: 'status', state: 'error', message: err.message }))
process.on('unhandledRejection', (err) => post({ type: 'log', level: 'error', text: fmt([err]) }))
