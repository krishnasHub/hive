import { beforeEach, describe, expect, it } from 'vitest'
import type { NotificationSettings, OutboundMessage, Presence, SessionInfo } from '../../shared/types'
import { NotificationRouter } from '../notificationRouter'

const settings: NotificationSettings = {
  remoteWhen: 'away',
  awayAfterSec: 120,
  remoteDelaySec: 10,
  finishedMinSec: 60,
  notifyOn: { permission: true, finished: true, waiting: true },
  interceptPermissions: 'always',
  permissionTimeoutSec: 3600
}

function harness() {
  let now = 0
  let ids = 0
  let presence: Presence = 'away'
  const timers: { at: number; fn: () => void; h: number }[] = []
  const sent: { channel: string; msg: OutboundMessage }[] = []
  const toasts: OutboundMessage[] = []
  const sessions = new Map<string, SessionInfo>()
  const cfg = { ...settings }
  const router = new NotificationRouter({
    now: () => now,
    setTimer: (fn, ms) => {
      const h = ++ids
      timers.push({ at: now + ms, fn, h })
      return h
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.h === h)
      if (i >= 0) timers.splice(i, 1)
    },
    newId: () => `m${++ids}`,
    settings: () => cfg,
    presence: () => presence,
    getSession: (id) => sessions.get(id),
    listSessions: () => [...sessions.values()],
    channels: () => ['slack'],
    sendToChannel: async (channel, msg) => {
      sent.push({ channel, msg })
      return { threadRef: `t-${msg.id}` }
    },
    desktop: (msg) => toasts.push(msg)
  })
  const advance = async (ms: number) => {
    now += ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > now) break
      timers.shift()
      next.fn()
      await Promise.resolve()
    }
    await new Promise((r) => setTimeout(r, 0))
  }
  return {
    router,
    sent,
    toasts,
    sessions,
    cfg,
    advance,
    setPresence: (p: Presence) => (presence = p)
  }
}

const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 's1',
  shortCode: 'H7K',
  title: 'api-server',
  cwd: '/p',
  status: 'waiting_permission',
  createdAt: 0,
  lastActivityAt: 0,
  pending: { requestId: 'r1', toolName: 'Bash', summary: 'Bash: npm run migrate', toolInput: {}, createdAt: 0, held: true },
  ...over
})

describe('NotificationRouter', () => {
  let h: ReturnType<typeof harness>
  beforeEach(() => {
    h = harness()
  })

  it('toasts immediately and forwards after the delay when away', async () => {
    const s = session()
    h.sessions.set(s.id, s)
    h.router.notify(s, 'permission', 'wants to run', { detail: 'npm run migrate', requestId: 'r1' })
    expect(h.toasts).toHaveLength(1)
    await h.advance(9_000)
    expect(h.sent).toHaveLength(0)
    await h.advance(1_000)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].msg.text).toContain('[H7K]')
    expect(h.sent[0].msg.actions.map((a) => a.id)).toEqual(['approve', 'deny'])
  })

  it('does not forward if you answered at the desk', async () => {
    const s = session()
    h.sessions.set(s.id, s)
    h.router.notify(s, 'permission', 'x', { requestId: 'r1' })
    h.sessions.set(s.id, { ...s, status: 'working', pending: undefined })
    await h.advance(60_000)
    expect(h.sent).toHaveLength(0)
  })

  it('waits while you are present, then forwards once you walk away', async () => {
    h.setPresence('present')
    const s = session()
    h.sessions.set(s.id, s)
    h.router.notify(s, 'permission', 'x', { requestId: 'r1' })
    await h.advance(60_000)
    expect(h.sent).toHaveLength(0)
    h.setPresence('away')
    await h.advance(15_000)
    expect(h.sent).toHaveLength(1)
  })

  it('never forwards when remoteWhen is never', async () => {
    h.cfg.remoteWhen = 'never'
    const s = session()
    h.sessions.set(s.id, s)
    h.router.notify(s, 'permission', 'x')
    await h.advance(60_000)
    expect(h.sent).toHaveLength(0)
    expect(h.toasts).toHaveLength(1)
  })

  it('routes a threaded reply back to its session and request', async () => {
    const s = session()
    h.sessions.set(s.id, s)
    h.router.notify(s, 'permission', 'x', { requestId: 'r1' })
    await h.advance(10_000)
    const threadRef = `t-${h.sent[0].msg.id}`
    const r = h.router.resolveReply({ channelId: 'slack', threadRef, text: 'yes, but skip seeds' })
    expect(r).toMatchObject({ session: { id: 's1' }, requestId: 'r1', action: { type: 'approve', followUp: 'skip seeds' } })
  })

  it('routes by session code when there is no thread', () => {
    const a = session({ id: 'a', shortCode: 'A2B', status: 'idle', pending: undefined })
    const b = session({ id: 'b', shortCode: 'C3D', status: 'idle', pending: undefined })
    h.sessions.set('a', a)
    h.sessions.set('b', b)
    const r = h.router.resolveReply({ channelId: 'telegram', text: 'c3d: run the tests' })
    expect(r).toMatchObject({ session: { id: 'b' }, action: { type: 'text', text: 'run the tests' } })
    const amb = h.router.resolveReply({ channelId: 'telegram', text: 'run the tests' })
    expect(amb).toHaveProperty('error')
  })
})
