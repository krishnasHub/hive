import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '../../shared/types'
import { applyHook, DEFAULT_TITLE, summarizeToolInput } from '../sessionState'

const base = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 's1',
  shortCode: 'H7K',
  title: DEFAULT_TITLE,
  cwd: '/proj',
  status: 'idle',
  createdAt: 0,
  lastActivityAt: 0,
  ...over
})

describe('applyHook', () => {
  it('prompt -> working and titles the session', () => {
    const t = applyHook(base(), 'UserPromptSubmit', { prompt: 'Fix   the login\nbug' }, 100)
    expect(t.session.status).toBe('working')
    expect(t.session.workStartedAt).toBe(100)
    expect(t.session.title).toBe('Fix the login bug')
  })

  it('does not overwrite a locked or custom title', () => {
    expect(applyHook(base(), 'UserPromptSubmit', { prompt: 'x' }, 1, true).session.title).toBe(DEFAULT_TITLE)
    expect(applyHook(base({ title: 'Mine' }), 'UserPromptSubmit', { prompt: 'x' }, 1).session.title).toBe('Mine')
  })

  it('stop -> idle with duration and last message', () => {
    const t = applyHook(base({ status: 'working', workStartedAt: 1000 }), 'Stop', { last_assistant_message: 'Done' }, 61_000)
    expect(t.session.status).toBe('idle')
    expect(t.signal).toEqual({ type: 'finished', durationMs: 60_000, message: 'Done' })
  })

  it('permission_prompt notification is ignored while Hive holds the request', () => {
    const held = base({
      status: 'waiting_permission',
      pending: { requestId: 'r', toolName: 'Bash', summary: 'x', toolInput: {}, createdAt: 0, held: true }
    })
    expect(applyHook(held, 'Notification', { notification_type: 'permission_prompt' }, 5).signal).toBeUndefined()
    const free = applyHook(base({ status: 'working' }), 'Notification', { notification_type: 'permission_prompt', message: 'm' }, 5)
    expect(free.session.status).toBe('waiting_permission')
    expect(free.signal?.type).toBe('permission_prompt')
  })

  it('notifications do not count as activity', () => {
    const t = applyHook(base({ status: 'working', lastActivityAt: 7 }), 'Notification', { notification_type: 'agent_needs_input' }, 99)
    expect(t.session.lastActivityAt).toBe(7)
    expect(t.session.status).toBe('waiting_input')
  })

  it('idle_prompt after a finished turn is not a new event', () => {
    expect(applyHook(base({ status: 'idle' }), 'Notification', { notification_type: 'idle_prompt' }, 9).signal).toBeUndefined()
  })

  it('tool use clears a pending permission', () => {
    const t = applyHook(
      base({ status: 'waiting_permission', pending: { requestId: 'r', toolName: 'Bash', summary: '', toolInput: {}, createdAt: 0, held: false } }),
      'PostToolUse',
      {},
      3
    )
    expect(t.session.status).toBe('working')
    expect(t.session.pending).toBeUndefined()
  })

  it('late tool events after Stop do not reopen a finished turn', () => {
    const done = base({ status: 'idle', lastActivityAt: 50 })
    expect(applyHook(done, 'PostToolUse', {}, 99).session).toMatchObject({ status: 'idle', lastActivityAt: 50 })
    expect(applyHook(done, 'PreToolUse', { agent_id: 'sub1' }, 99).session.status).toBe('idle')
    expect(applyHook(done, 'PreToolUse', {}, 99).session.status).toBe('working')
  })

  it('SessionEnd from /clear keeps the session alive', () => {
    expect(applyHook(base(), 'SessionEnd', { reason: 'clear' }, 1).session.status).toBe('idle')
    expect(applyHook(base(), 'SessionEnd', { reason: 'prompt_input_exit' }, 1).session.status).toBe('exited')
  })
})

describe('summarizeToolInput', () => {
  it('prefers the command or path', () => {
    expect(summarizeToolInput('Bash', { command: 'npm test', description: 'x' })).toBe('Bash: npm test')
    expect(summarizeToolInput('Edit', { file_path: '/a.ts' })).toBe('Edit: /a.ts')
    expect(summarizeToolInput('Thing', {})).toBe('Thing')
  })
})
