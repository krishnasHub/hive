// Builds the per-session `--settings` JSON that points Claude Code's hooks at Hive's local server.

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd'
] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]

export interface HookSettingsOptions {
  port: number
  token: string
  sessionId: string
  /** Seconds Claude Code waits on a held PermissionRequest. */
  permissionTimeoutSec: number
  /** Leave out PermissionRequest entirely (permissions handled in the terminal). */
  interceptPermissions: boolean
}

export function buildHookSettings(o: HookSettingsOptions): { hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = {}
  for (const event of HOOK_EVENTS) {
    if (event === 'PermissionRequest' && !o.interceptPermissions) continue
    const hook: Record<string, unknown> = {
      type: 'http',
      url: `http://127.0.0.1:${o.port}/hook/${encodeURIComponent(o.sessionId)}/${event}`,
      headers: { Authorization: `Bearer ${o.token}` }
    }
    // Everything except a held permission prompt answers immediately.
    hook.timeout = event === 'PermissionRequest' ? o.permissionTimeoutSec : 10
    hooks[event] = [{ hooks: [hook] }]
  }
  return { hooks }
}

export function permissionDecision(behavior: 'allow' | 'deny', message?: string, interrupt?: boolean) {
  const decision: Record<string, unknown> = { behavior }
  if (behavior === 'deny') {
    if (message) decision.message = message
    if (interrupt) decision.interrupt = true
  }
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }
}
