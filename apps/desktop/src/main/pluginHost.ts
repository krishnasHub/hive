// Discovers Hive plugins, runs each enabled one in its own utilityProcess, and relays channel traffic.
import { utilityProcess, type UtilityProcess } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import runtimePath from './pluginRuntime?modulePath'
import type { InboundReply, OutboundMessage, PluginInfo, PluginManifest, PluginRunState } from '@shared/types'
import { builtinPluginsDir, paths } from './paths'
import type { SettingsStore } from './store'

const SUPPORTED_API = 1
const CALL_TIMEOUT_MS = 30_000

interface Entry {
  manifest: PluginManifest
  dir: string
  builtin: boolean
  runState: PluginRunState
  statusMessage?: string
  proc?: UtilityProcess
  calls: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>
  restarts: number
}

export interface PluginHostEvents {
  reply: [InboundReply]
  change: []
  log: [string, string, string] // pluginId, level, text
}

let callSeq = 0

export class PluginHost extends EventEmitter<PluginHostEvents> {
  private entries = new Map<string, Entry>()

  constructor(private store: SettingsStore) {
    super()
  }

  discover() {
    const scan = (root: string, builtin: boolean) => {
      if (!existsSync(root)) return
      for (const name of readdirSync(root)) {
        const dir = join(root, name)
        const file = join(dir, 'hive-plugin.json')
        if (!existsSync(file)) continue
        try {
          const manifest = JSON.parse(readFileSync(file, 'utf8')) as PluginManifest
          if (!manifest.id || !manifest.main) throw new Error('manifest needs id and main')
          if (manifest.hiveApi !== SUPPORTED_API) throw new Error(`needs hiveApi ${manifest.hiveApi}, Hive supports ${SUPPORTED_API}`)
          // User plugins with the same id override built-ins (handy while developing one).
          if (this.entries.has(manifest.id) && builtin) continue
          this.entries.set(manifest.id, { manifest, dir, builtin, runState: 'disabled', calls: new Map(), restarts: 0 })
        } catch (err) {
          console.error(`[hive] skipping plugin at ${dir}: ${(err as Error).message}`)
        }
      }
    }
    scan(paths.userPlugins, false)
    scan(builtinPluginsDir(), true)
  }

  startEnabled() {
    for (const e of this.entries.values()) if (this.store.plugin(e.manifest.id).enabled) this.start(e)
    this.emit('change')
  }

  list(): PluginInfo[] {
    return [...this.entries.values()].map((e) => {
      const state = this.store.plugin(e.manifest.id)
      const masked: Record<string, unknown> = { ...state.settings }
      for (const f of e.manifest.settings ?? []) {
        if (f.type === 'secret') masked[f.key] = this.store.getSecret(e.manifest.id, f.key) ? '••••••••' : ''
      }
      return {
        manifest: e.manifest,
        dir: e.dir,
        builtin: e.builtin,
        enabled: state.enabled,
        runState: state.enabled ? e.runState : 'disabled',
        statusMessage: e.statusMessage,
        settings: masked
      }
    })
  }

  /** Channel ids of plugins that are up and able to send. */
  runningChannels(): string[] {
    const out: string[] = []
    for (const e of this.entries.values()) {
      if (e.runState === 'running' && e.manifest.contributes?.channel) out.push(e.manifest.contributes.channel.id)
    }
    return out
  }

  setEnabled(id: string, enabled: boolean) {
    const e = this.entries.get(id)
    if (!e) return
    const state = this.store.plugin(id)
    this.store.setPlugin(id, { ...state, enabled })
    if (enabled) this.restart(e)
    else this.stop(e)
    this.emit('change')
  }

  /** Save settings; secret fields go to the keychain. A masked value means "unchanged". */
  configure(id: string, values: Record<string, unknown>) {
    const e = this.entries.get(id)
    if (!e) return
    const state = this.store.plugin(id)
    const plain: Record<string, unknown> = { ...state.settings }
    for (const f of e.manifest.settings ?? []) {
      if (!(f.key in values)) continue
      const v = values[f.key]
      if (f.type === 'secret') {
        if (v === '••••••••') continue
        this.store.setSecret(id, f.key, typeof v === 'string' ? v.trim() : undefined)
      } else {
        plain[f.key] = typeof v === 'string' ? v.trim() : v
      }
    }
    this.store.setPlugin(id, { ...state, settings: plain })
    if (state.enabled) this.restart(e)
    this.emit('change')
  }

  async test(id: string): Promise<string> {
    const e = this.entries.get(id)
    if (!e) throw new Error('Unknown plugin')
    if (e.runState !== 'running') throw new Error(e.statusMessage || 'Plugin is not running — enable it and check its settings.')
    return String(await this.call(e, { type: 'test' }))
  }

  async send(channelId: string, message: OutboundMessage): Promise<{ threadRef?: string }> {
    const e = [...this.entries.values()].find((x) => x.manifest.contributes?.channel?.id === channelId)
    if (!e) throw new Error(`No plugin provides channel ${channelId}`)
    const r = (await this.call(e, { type: 'send', message })) as { threadRef?: unknown }
    return { threadRef: r?.threadRef != null ? String(r.threadRef) : undefined }
  }

  stopAll() {
    for (const e of this.entries.values()) this.stop(e)
  }

  // ---------- process management ----------

  private settingsFor(e: Entry): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    const saved = this.store.plugin(e.manifest.id).settings
    for (const f of e.manifest.settings ?? []) {
      out[f.key] = f.type === 'secret' ? (this.store.getSecret(e.manifest.id, f.key) ?? '') : (saved[f.key] ?? f.default)
    }
    return out
  }

  private missingRequired(e: Entry): string[] {
    const s = this.settingsFor(e)
    return (e.manifest.settings ?? []).filter((f) => f.required && (s[f.key] === undefined || s[f.key] === '')).map((f) => f.label)
  }

  private restart(e: Entry) {
    this.stop(e)
    e.restarts = 0
    this.start(e)
  }

  private start(e: Entry) {
    const missing = this.missingRequired(e)
    if (missing.length) {
      this.setState(e, 'error', `Missing settings: ${missing.join(', ')}`)
      return
    }
    this.setState(e, 'starting')
    const proc = utilityProcess.fork(runtimePath, [], {
      serviceName: `Hive plugin ${e.manifest.id}`,
      stdio: 'pipe',
      env: { ...process.env, HIVE_PLUGIN_ID: e.manifest.id }
    })
    e.proc = proc
    proc.stdout?.on('data', (d) => this.emit('log', e.manifest.id, 'info', String(d).trimEnd()))
    proc.stderr?.on('data', (d) => this.emit('log', e.manifest.id, 'error', String(d).trimEnd()))
    proc.on('message', (m: Record<string, unknown>) => this.onMessage(e, m))
    proc.on('exit', (code) => {
      if (e.proc !== proc) return
      e.proc = undefined
      for (const c of e.calls.values()) {
        clearTimeout(c.timer)
        c.reject(new Error('Plugin stopped'))
      }
      e.calls.clear()
      if (!this.store.plugin(e.manifest.id).enabled) return
      // Crashed: back off and retry a few times.
      if (e.restarts < 5) {
        const delay = 2000 * 2 ** e.restarts++
        this.setState(e, 'error', `Plugin exited (code ${code}); restarting in ${delay / 1000}s`)
        setTimeout(() => {
          if (!e.proc && this.store.plugin(e.manifest.id).enabled) this.start(e)
        }, delay)
      } else {
        this.setState(e, 'error', `Plugin keeps crashing (code ${code}). Check its settings and logs.`)
      }
    })
    proc.postMessage({
      type: 'init',
      dir: e.dir,
      main: e.manifest.main,
      dataDir: join(paths.pluginData, e.manifest.id),
      settings: this.settingsFor(e)
    })
  }

  private stop(e: Entry) {
    const proc = e.proc
    e.proc = undefined
    if (proc) {
      proc.postMessage({ type: 'stop' })
      setTimeout(() => proc.kill(), 2000)
    }
    this.setState(e, 'stopped')
  }

  private onMessage(e: Entry, m: Record<string, unknown>) {
    switch (m.type) {
      case 'ready':
        e.restarts = 0
        if (e.runState !== 'error') this.setState(e, 'running')
        break
      case 'status':
        this.setState(e, m.state === 'error' ? 'error' : 'running', m.message ? String(m.message) : undefined)
        break
      case 'log':
        this.emit('log', e.manifest.id, String(m.level), String(m.text))
        break
      case 'reply': {
        const channelId = e.manifest.contributes?.channel?.id
        if (!channelId) return
        const r = m.reply as Omit<InboundReply, 'channelId'>
        this.emit('reply', { ...r, channelId })
        break
      }
      case 'result': {
        const c = e.calls.get(String(m.id))
        if (!c) return
        e.calls.delete(String(m.id))
        clearTimeout(c.timer)
        if (m.ok) c.resolve(m.value)
        else c.reject(new Error(String(m.error)))
        break
      }
    }
  }

  private call(e: Entry, msg: Record<string, unknown>): Promise<unknown> {
    const proc = e.proc
    if (!proc) return Promise.reject(new Error(`${e.manifest.name} is not running`))
    const id = String(++callSeq)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        e.calls.delete(id)
        reject(new Error(`${e.manifest.name} did not answer in time`))
      }, CALL_TIMEOUT_MS)
      e.calls.set(id, { resolve, reject, timer })
      proc.postMessage({ ...msg, id })
    })
  }

  private setState(e: Entry, state: PluginRunState, message?: string) {
    e.runState = state
    e.statusMessage = message
    this.emit('change')
  }
}
