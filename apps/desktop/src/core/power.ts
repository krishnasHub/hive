// Pure power-management logic: what to hold, and parsing Windows powercfg output.
// No Electron imports so it stays unit-testable.
import type { LidMode } from '../shared/types'

/** How the lid-close action is being overridden. */
export type LidOverride = 'none' | 'ac' | 'ac+dc' | 'inhibit'

export interface PowerDecision {
  /** Hold a powerSaveBlocker against idle sleep. */
  blockIdle: boolean
  /** Lid override that should be in effect right now. */
  lid: LidOverride
}

export interface PowerSettings {
  keepAwake: boolean
  lidClosed: LidMode
}

export function decide(
  activeSessions: number,
  settings: PowerSettings,
  onBattery: boolean,
  platform: NodeJS.Platform | string
): PowerDecision {
  const active = settings.keepAwake && activeSessions > 0
  if (!active || settings.lidClosed === 'off') return { blockIdle: active, lid: 'none' }
  if (platform === 'win32') {
    // Setting only the AC index already means "do nothing when plugged in", sleep on battery.
    return { blockIdle: true, lid: settings.lidClosed === 'always' ? 'ac+dc' : 'ac' }
  }
  if (platform === 'linux') {
    if (settings.lidClosed === 'plugged-in' && onBattery) return { blockIdle: true, lid: 'none' }
    return { blockIdle: true, lid: 'inhibit' }
  }
  return { blockIdle: true, lid: 'none' }
}

export const SUB_BUTTONS = '4f971e89-eebd-4455-a8de-9e59040e7347'
export const LIDACTION = '5ca83367-6e45-459f-a27b-476b1d01c936'

export interface LidValues {
  /** Power scheme GUID the values belong to. */
  scheme: string
  ac: number
  dc: number
}

/**
 * Parse `powercfg /query SCHEME_CURRENT SUB_BUTTONS LIDACTION`. The labels are localized,
 * so read the scheme GUID from the first line and the two `0x…` values in order (AC, DC).
 * Returns null when the machine has no lid setting (only the scheme lines are printed).
 */
export function parseLidQuery(output: string): LidValues | null {
  const scheme = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(output)?.[0]
  if (!scheme || !output.toLowerCase().includes(LIDACTION)) return null
  const hex = output.match(/0x[0-9a-f]+/gi)
  if (!hex || hex.length < 2) return null
  const ac = parseInt(hex[0], 16)
  const dc = parseInt(hex[1], 16)
  if (!Number.isFinite(ac) || !Number.isFinite(dc)) return null
  return { scheme: scheme.toLowerCase(), ac, dc }
}

/** Saved before Hive changes the lid action, so a crashed Hive can put it back. */
export interface LidState extends LidValues {
  platform: 'win32'
  mode: LidOverride
}

export function parseLidState(text: string): LidState | null {
  try {
    const v = JSON.parse(text) as Partial<LidState>
    if (
      v &&
      v.platform === 'win32' &&
      typeof v.scheme === 'string' &&
      /^[0-9a-f-]{36}$/i.test(v.scheme) &&
      Number.isInteger(v.ac) &&
      Number.isInteger(v.dc)
    ) {
      return { platform: 'win32', scheme: v.scheme, ac: v.ac!, dc: v.dc!, mode: v.mode ?? 'ac' }
    }
  } catch {
    // fall through
  }
  return null
}

/** powercfg argument lists to apply a lid override (ac/dc = 0 means "do nothing"). */
export function lidSetCommands(scheme: string, ac: number, dc: number): string[][] {
  return [
    ['/setacvalueindex', scheme, SUB_BUTTONS, LIDACTION, String(ac)],
    ['/setdcvalueindex', scheme, SUB_BUTTONS, LIDACTION, String(dc)],
    ['/setactive', 'SCHEME_CURRENT']
  ]
}

/** Values to write while an override is engaged (the untouched index keeps its original value). */
export function engagedValues(original: LidValues, mode: LidOverride): { ac: number; dc: number } {
  return { ac: 0, dc: mode === 'ac+dc' ? 0 : original.dc }
}

export const MAC_LID_MESSAGE =
  "macOS sleeps when the lid closes unless it's on power with an external display. Hive keeps it awake otherwise."
export const NO_LID_MESSAGE = 'This computer has no lid setting'
