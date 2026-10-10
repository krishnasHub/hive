// Pure state transitions for a session, driven by Claude Code hook events.
import type { SessionInfo, SessionStatus } from '../shared/types'

export interface HookPayload {
  hook_event_name?: string
  session_id?: string
  prompt?: string
  session_title?: string
  message?: string
  title?: string
  notification_type?: string
  tool_name?: string
  tool_input?: unknown
  last_assistant_message?: string
  reason?: string
  [k: string]: unknown
}

/** What changed, so the caller can decide whether to notify. */
export type SessionSignal =
  | { type: 'finished'; durationMs: number; message?: string }
  | { type: 'waiting'; message: string }
  | { type: 'permission_prompt'; message: string } // terminal dialog shown (not held by Hive)
  | { type: 'activity' }
  | { type: 'ended' }

export interface Transition {
  session: SessionInfo
  signal?: SessionSignal
}

const WAITING_TYPES = new Set(['idle_prompt', 'agent_needs_input', 'elicitation_dialog', 'elicitation_url_dialog'])

export function titleFromPrompt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  return oneLine.length > 48 ? oneLine.slice(0, 47) + '…' : oneLine
}

export function applyHook(prev: SessionInfo, event: string, p: HookPayload, now: number, titleLocked = false): Transition {
  // Notifications are Claude nagging, not activity; don't let them reset "last activity".
  const s: SessionInfo = { ...prev, lastActivityAt: event === 'Notification' ? prev.lastActivityAt : now }
  const set = (status: SessionStatus) => {
    s.status = status
  }

  switch (event) {
    case 'SessionStart':
      if (s.status === 'starting') set('idle')
      return { session: s }

    case 'UserPromptSubmit': {
      set('working')
      s.workStartedAt = now
      s.pending = undefined
      if (!titleLocked) {
        if (typeof p.session_title === 'string' && p.session_title) s.title = p.session_title
        else if (typeof p.prompt === 'string' && p.prompt && isDefaultTitle(prev.title)) s.title = titleFromPrompt(p.prompt)
      }
      return { session: s, signal: { type: 'activity' } }
    }

    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      // After a finished turn, only a new tool call by the main agent means real work resumed
      // (e.g. Claude continuing after a background task). Late "post" events and background
      // subagents must not flip a done session back to working.
      if (s.status === 'idle' && (event !== 'PreToolUse' || p.agent_id)) return { session: { ...s, lastActivityAt: prev.lastActivityAt } }
      // Tool ran, so any permission question has been answered.
      if (s.status !== 'working') set('working')
      if (!s.workStartedAt) s.workStartedAt = now
      s.pending = undefined
      return { session: s, signal: { type: 'activity' } }

    case 'Notification': {
      const type = p.notification_type ?? ''
      const message = String(p.message ?? p.title ?? 'Claude needs your attention')
      if (type === 'permission_prompt') {
        if (s.pending?.held) return { session: s } // Hive is already handling this one
        set('waiting_permission')
        return { session: s, signal: { type: 'permission_prompt', message } }
      }
      if (WAITING_TYPES.has(type)) {
        // idle_prompt fires long after Stop; don't downgrade a finished turn into noise.
        if (type === 'idle_prompt' && s.status === 'idle') return { session: s }
        set('waiting_input')
        return { session: s, signal: { type: 'waiting', message } }
      }
      return { session: s }
    }

    case 'Stop':
    case 'StopFailure': {
      const started = s.workStartedAt ?? now
      set('idle')
      s.pending = undefined
      s.workStartedAt = undefined
      if (typeof p.last_assistant_message === 'string') s.lastAssistantMessage = p.last_assistant_message
      return { session: s, signal: { type: 'finished', durationMs: now - started, message: s.lastAssistantMessage } }
    }

    case 'SessionEnd':
      // /clear and interactive /resume end one conversation but the process lives on.
      if (p.reason === 'clear' || p.reason === 'resume') return { session: s }
      set('exited')
      s.pending = undefined
      return { session: s, signal: { type: 'ended' } }

    default:
      return { session: s }
  }
}

export const DEFAULT_TITLE = 'New session'

export function isDefaultTitle(title: string): boolean {
  return !title || title === DEFAULT_TITLE
}

/** One-line description of a tool call for approval prompts. */
export function summarizeToolInput(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const pick =
    str(i.command) ??
    str(i.file_path) ??
    str(i.path) ??
    str(i.url) ??
    str(i.pattern) ??
    str(i.query) ??
    str(i.description) ??
    (Object.keys(i).length ? JSON.stringify(i) : '')
  const text = (pick ?? '').replace(/\s+$/g, '')
  const clipped = text.length > 400 ? text.slice(0, 399) + '…' : text
  return clipped ? `${toolName}: ${clipped}` : toolName
}
