// Decides when a session event becomes a notification, where it goes, and how replies find their way back.
import type {
  InboundReply,
  NotificationKind,
  NotificationSettings,
  OutboundAction,
  OutboundMessage,
  Presence,
  SessionInfo
} from '../shared/types'
import { extractSessionCode, parseReply, type ReplyAction } from './replyParser'

export interface RouterDeps {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  newId(): string
  settings(): NotificationSettings
  presence(): Presence
  getSession(id: string): SessionInfo | undefined
  listSessions(): SessionInfo[]
  /** Channel ids that are enabled and running. */
  channels(): string[]
  sendToChannel(channelId: string, msg: OutboundMessage): Promise<{ threadRef?: string }>
  desktop(msg: OutboundMessage): void
  log?(text: string): void
}

interface Ticket {
  msg: OutboundMessage
  sessionId: string
  kind: NotificationKind
  requestId?: string
  activityAt: number
  createdAt: number
  timer?: unknown
  sent: boolean
}

interface ThreadEntry {
  sessionId: string
  requestId?: string
  sentAt: number
}

export interface ResolvedReply {
  session: SessionInfo
  action: ReplyAction
  /** Permission request the reply was aimed at, if any. */
  requestId?: string
}

const RECHECK_MS = 15_000
const TICKET_MAX_AGE_MS = 12 * 60 * 60 * 1000
const FALLBACK_WINDOW_MS = 12 * 60 * 60 * 1000

export class NotificationRouter {
  private tickets = new Map<string, Ticket>() // by sessionId (one live ticket per session)
  private threads = new Map<string, ThreadEntry>() // `${channel}|${threadRef}`
  private lastSent = new Map<string, ThreadEntry>() // by channel

  constructor(private d: RouterDeps) {}

  /** Session needs attention. Desktop toast now; remote channels after a delay if you're still needed. */
  notify(session: SessionInfo, kind: NotificationKind, body: string, opts: { detail?: string; requestId?: string } = {}) {
    const s = this.d.settings()
    if (kind === 'permission' || kind === 'finished' || kind === 'waiting') {
      if (!s.notifyOn[kind]) return
    }
    this.cancel(session.id)
    const msg = buildMessage(this.d.newId(), session, kind, body, opts.detail)
    this.d.desktop(msg)

    if (s.remoteWhen === 'never' || this.d.channels().length === 0) return
    const ticket: Ticket = {
      msg,
      sessionId: session.id,
      kind,
      requestId: opts.requestId,
      activityAt: session.lastActivityAt,
      createdAt: this.d.now(),
      sent: false
    }
    this.tickets.set(session.id, ticket)
    ticket.timer = this.d.setTimer(() => this.fire(ticket), Math.max(0, s.remoteDelaySec * 1000))
  }

  /** The session moved on (you answered at the desk, or Claude kept going). */
  cancel(sessionId: string) {
    const t = this.tickets.get(sessionId)
    if (!t) return
    if (t.timer) this.d.clearTimer(t.timer)
    this.tickets.delete(sessionId)
  }

  pendingCount(): number {
    return this.tickets.size
  }

  private stillRelevant(t: Ticket): boolean {
    const s = this.d.getSession(t.sessionId)
    if (!s) return false
    if (this.d.now() - t.createdAt > TICKET_MAX_AGE_MS) return false
    switch (t.kind) {
      case 'permission':
        return s.status === 'waiting_permission' && (!t.requestId || s.pending?.requestId === t.requestId)
      case 'waiting':
        return s.status === 'waiting_input'
      case 'finished':
        return s.status === 'idle' && s.lastActivityAt === t.activityAt
      default:
        return true
    }
  }

  private fire(t: Ticket) {
    t.timer = undefined
    if (this.tickets.get(t.sessionId) !== t) return
    if (!this.stillRelevant(t)) {
      this.tickets.delete(t.sessionId)
      return
    }
    const s = this.d.settings()
    if (s.remoteWhen === 'away' && this.d.presence() !== 'away') {
      // You're at the desk. Keep the ticket armed in case you walk away without answering.
      t.timer = this.d.setTimer(() => this.fire(t), RECHECK_MS)
      return
    }
    this.tickets.delete(t.sessionId)
    void this.broadcast(t.msg, t.requestId)
  }

  /** Sends to every running channel and remembers threads so replies route back. */
  async broadcast(msg: OutboundMessage, requestId?: string): Promise<void> {
    for (const channelId of this.d.channels()) {
      try {
        const { threadRef } = await this.d.sendToChannel(channelId, msg)
        if (!msg.sessionId) continue
        const entry: ThreadEntry = { sessionId: msg.sessionId, requestId, sentAt: this.d.now() }
        if (threadRef) this.threads.set(`${channelId}|${threadRef}`, entry)
        this.lastSent.set(channelId, entry)
      } catch (err) {
        this.d.log?.(`Failed to send to ${channelId}: ${(err as Error).message}`)
      }
    }
  }

  /** Remembers a thread for a message sent outside broadcast (e.g. an ack). */
  rememberThread(channelId: string, threadRef: string, sessionId: string) {
    const entry = { sessionId, sentAt: this.d.now() }
    this.threads.set(`${channelId}|${threadRef}`, entry)
    this.lastSent.set(channelId, entry)
  }

  /** Works out which session a chat reply is for and what it asks for. */
  resolveReply(reply: InboundReply): ResolvedReply | { error: string } {
    const sessions = this.d.listSessions().filter((s) => s.status !== 'exited' && s.status !== 'dormant')
    let text = reply.text ?? ''
    let entry: ThreadEntry | undefined
    if (reply.threadRef) entry = this.threads.get(`${reply.channelId}|${reply.threadRef}`)

    let session = entry ? this.d.getSession(entry.sessionId) : undefined
    if (!session) {
      const { code, rest } = extractSessionCode(text, sessions.map((s) => s.shortCode))
      if (code) {
        session = sessions.find((s) => s.shortCode === code)
        text = rest
      }
    }
    if (!session) {
      const last = this.lastSent.get(reply.channelId)
      if (last && this.d.now() - last.sentAt < FALLBACK_WINDOW_MS) {
        session = this.d.getSession(last.sessionId)
        entry = last
      }
    }
    if (!session && sessions.length === 1) session = sessions[0]
    if (!session) {
      const codes = sessions.map((s) => `${s.shortCode} (${s.title})`).join(', ')
      return {
        error: sessions.length
          ? `Which session? Start your reply with its code, e.g. "${sessions[0].shortCode}: …". Open: ${codes}`
          : 'No Claude sessions are running in Hive right now.'
      }
    }
    if (session.status === 'exited' || session.status === 'dormant') {
      return { error: `Session ${session.shortCode} isn't running. Open Hive to resume it.` }
    }
    const action = parseReply(text, reply.actionId)
    return { session, action, requestId: entry?.requestId ?? session.pending?.requestId }
  }
}

const KIND_ICON: Record<NotificationKind, string> = {
  permission: '🔐',
  finished: '✅',
  waiting: '💬',
  test: '🐝',
  info: '🐝'
}

export function buildMessage(
  id: string,
  session: SessionInfo,
  kind: NotificationKind,
  body: string,
  detail?: string
): OutboundMessage {
  const actions: OutboundAction[] =
    kind === 'permission'
      ? [
          { id: 'approve', label: 'Approve' },
          { id: 'deny', label: 'Deny' }
        ]
      : kind === 'test' || kind === 'info'
        ? []
        : [{ id: 'status', label: 'Status' }]
  const headline =
    kind === 'permission'
      ? 'needs permission'
      : kind === 'finished'
        ? 'finished'
        : kind === 'waiting'
          ? 'is waiting for you'
          : kind === 'test'
            ? 'test'
            : ''
  const title = `${KIND_ICON[kind]} [${session.shortCode}] ${session.title} ${headline}`
  const hint =
    kind === 'permission'
      ? 'Reply "yes" / "no", or "no, <what to do instead>".'
      : kind === 'test' || kind === 'info'
        ? ''
        : 'Reply to continue the session.'
  const parts = [title, clip(body, 1500)]
  if (detail) parts.push('```\n' + clip(detail, 1500) + '\n```')
  if (hint) parts.push(hint)
  return {
    id,
    kind,
    sessionId: session.id,
    sessionCode: session.shortCode,
    sessionTitle: session.title,
    cwd: session.cwd,
    title,
    body: clip(body, 1500),
    detail,
    actions,
    text: parts.filter(Boolean).join('\n\n')
  }
}

export function clip(text: string, max: number): string {
  if (!text) return ''
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

export function statusText(s: SessionInfo, now: number): string {
  const ago = (t: number) => {
    const sec = Math.round((now - t) / 1000)
    return sec < 90 ? `${sec}s` : sec < 5400 ? `${Math.round(sec / 60)}m` : `${Math.round(sec / 3600)}h`
  }
  const lines = [`[${s.shortCode}] ${s.title}`, `Status: ${s.status.replace('_', ' ')} · last activity ${ago(s.lastActivityAt)} ago`]
  if (s.status === 'working' && s.workStartedAt) lines.push(`Working for ${ago(s.workStartedAt)}`)
  if (s.pending) lines.push(`Waiting on: ${s.pending.summary}`)
  if (s.lastAssistantMessage) lines.push('', 'Last message:', clip(s.lastAssistantMessage, 1200))
  return lines.join('\n')
}

/** A short message that isn't tied to a notification (acks, errors), threaded under `replyTo` if given. */
export function infoMessage(id: string, text: string, replyTo?: string, session?: SessionInfo): OutboundMessage {
  return {
    id,
    kind: 'info',
    sessionId: session?.id,
    sessionCode: session?.shortCode,
    sessionTitle: session?.title,
    title: text.split('\n')[0],
    body: text,
    actions: [],
    text,
    replyTo
  }
}
