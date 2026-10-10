// Settings on disk (~/.hive/settings.json) plus plugin secrets encrypted with the OS keychain.
import { safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { HiveSettings, PluginState } from '@shared/types'
import { paths } from './paths'

export const DEFAULT_SETTINGS: HiveSettings = {
  general: {
    claudePath: '',
    extraArgs: '',
    defaultCwd: homedir(),
    fontSize: 14,
    closeToTray: true,
    launchAtLogin: false,
    fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, Menlo, 'DejaVu Sans Mono', monospace"
  },
  notifications: {
    sound: true,
    soundVolume: 0.6,
    remoteWhen: 'away',
    awayAfterSec: 120,
    remoteDelaySec: 15,
    finishedMinSec: 30,
    notifyOn: { permission: true, finished: true, waiting: true },
    interceptPermissions: 'always',
    permissionTimeoutSec: 6 * 60 * 60
  },
  plugins: {}
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch (err) {
    console.error(`[hive] could not read ${file}:`, err)
  }
  return fallback
}

/** Write to a temp file then rename, so a crash never leaves half a settings file. */
export function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, file)
}

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return (over ?? base) as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = out[k]
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? merge(b, v) : v
  }
  return out as T
}

export class SettingsStore {
  private data: HiveSettings
  private secrets: Record<string, string> // `${pluginId}.${key}` -> base64 ciphertext (or plain: prefix)
  private listeners = new Set<(s: HiveSettings) => void>()

  constructor() {
    this.data = merge(DEFAULT_SETTINGS, readJson(paths.settings, {}))
    this.secrets = readJson(paths.secrets, {})
  }

  get(): HiveSettings {
    return this.data
  }

  update(patch: Partial<HiveSettings>): HiveSettings {
    this.data = merge(this.data, patch)
    writeJsonAtomic(paths.settings, this.data)
    for (const l of this.listeners) l(this.data)
    return this.data
  }

  onChange(fn: (s: HiveSettings) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  plugin(id: string): PluginState {
    return this.data.plugins[id] ?? { enabled: false, settings: {} }
  }

  setPlugin(id: string, state: PluginState) {
    this.update({ plugins: { ...this.data.plugins, [id]: state } })
  }

  getSecret(pluginId: string, key: string): string | undefined {
    const raw = this.secrets[`${pluginId}.${key}`]
    if (!raw) return undefined
    if (raw.startsWith('plain:')) return raw.slice(6)
    try {
      return safeStorage.decryptString(Buffer.from(raw, 'base64'))
    } catch {
      return undefined
    }
  }

  setSecret(pluginId: string, key: string, value: string | undefined) {
    const k = `${pluginId}.${key}`
    if (!value) delete this.secrets[k]
    else if (safeStorage.isEncryptionAvailable()) this.secrets[k] = safeStorage.encryptString(value).toString('base64')
    else this.secrets[k] = `plain:${value}` // Linux without a keyring
    writeJsonAtomic(paths.secrets, this.secrets)
  }
}
