// Owns the `claude` processes: one PTY per tab, state from hooks, persistence across restarts.
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as pty from 'node-pty'
import type { PendingPermission, Presence, SessionInfo } from '@shared/types'
import { buildHookSettings, permissionDecision } from '@core/hookSettings'
import { applyHook, DEFAULT_TITLE, summarizeToolInput, type SessionSignal } from '@core/sessionState'
import { makeShortCode } from '@core/shortCode'
import type { HookRequest } from './hookServer'
import { paths } from './paths'
import { locateClaude, spawnTarget } from './claudeLocator'
import type { SettingsStore } from './store'
import { writeJsonAtomic } from './store'

interface PersistedSession {
  id: string
  claudeSessionId?: string
  shortCode: string
  title: string
  titleLocked?: boolean
  cwd: string
  createdAt: number
}

export type PermissionAnswer =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message?: string; interrupt?: boolean }
  | { behavior: 'terminal' } // let Claude Code show its own dialog

interface Live {
  info: SessionInfo
  claudeSessionId: string
  titleLocked: boolean
  proc?: pty.IPty
  /** Tail of terminal output, replayed if the window reloads. */
  scrollback: string
  outBuf: string
  /** Recent output with escape codes and spaces removed, for spotting dialogs. */
  screenTail: string
  /** The trust question was answered; Claude redraws it while handling the keys, so stop looking. */
  trustAnswered?: boolean
  /** Total characters emitted to the renderer; lets it splice scrollback and live data without duplicates. */
  emitted: number
  flushTimer?: NodeJS.Timeout
  startTimer?: NodeJS.Timeout
  held?: { requestId: string; resolve: (out: unknown) => void }
}

const SCROLLBACK_MAX = 256 * 1024
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?<>]*[a-zA-Z~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g
const BRACKET_START = '\x1b[200~'
const BRACKET_END = '\x1b[201~'

export interface SessionEvents {
  update: [SessionInfo]
  data: [string, string, number]
  signal: [SessionInfo, SessionSignal]
  permission: [SessionInfo, PendingPermission]
  removed: [string]
  error: [string, string]
}

export class SessionManager extends EventEmitter<SessionEvents> {
  private live = new Map<string, Live>()
  private hookPort = 0
  private hookToken = ''

  constructor(
    private store: SettingsStore,
    private presence: () => Presence
  ) {
    super()
  }

  setHookEndpoint(port: number, token: string) {
    this.hookPort = port
    this.hookToken = token
  }

  // ---------- persistence ----------

  restore() {
    let saved: PersistedSession[] = []
    try {
      if (existsSync(paths.sessions)) saved = JSON.parse(readFileSync(paths.sessions, 'utf8'))
    } catch (err) {
      console.error('[hive] could not read sessions', err)
    }
    for (const p of saved) {
      this.live.set(p.id, {
        info: {
          id: p.id,
          shortCode: p.shortCode,
          title: p.title,
          cwd: p.cwd,
          status: 'dormant',
          createdAt: p.createdAt,
          lastActivityAt: p.createdAt
        },
        claudeSessionId: p.claudeSessionId ?? p.id,
        titleLocked: !!p.titleLocked,
        scrollback: '',
        outBuf: '',
        screenTail: '',
        emitted: 0
      })
    }
  }

  private persist() {
    const out: PersistedSession[] = [...this.live.values()].map((l) => ({
      id: l.info.id,
      claudeSessionId: l.claudeSessionId,
      shortCode: l.info.shortCode,
      title: l.info.title,
      titleLocked: l.titleLocked,
      cwd: l.info.cwd,
      createdAt: l.info.createdAt
    }))
    writeJsonAtomic(paths.sessions, out)
  }

  // ---------- queries ----------

  list(): SessionInfo[] {
    return [...this.live.values()].map((l) => l.info)
  }

  get(id: string): SessionInfo | undefined {
    return this.live.get(id)?.info
  }

  /** Everything emitted so far (bounded), and the stream position it ends at. */
  scrollback(id: string): { text: string; end: number } {
    const l = this.live.get(id)
    if (!l) return { text: '', end: 0 }
    this.flush(l)
    return { text: l.scrollback, end: l.emitted }
  }

  findByClaudeSessionId(claudeSessionId: string): SessionInfo | undefined {
    for (const l of this.live.values()) if (l.claudeSessionId === claudeSessionId) return l.info
    return undefined
  }

  // ---------- lifecycle ----------

  /** New tab. Pass `resumeClaudeSessionId` to continue a conversation from history. */
  create(opts: { cwd: string; title?: string; resumeClaudeSessionId?: string }): SessionInfo {
    const id = randomUUID()
    const taken = new Set(this.list().map((s) => s.shortCode))
    const now = Date.now()
    const l: Live = {
      info: {
        id,
        shortCode: makeShortCode(taken),
        title: opts.title || DEFAULT_TITLE,
        cwd: opts.cwd,
        status: 'starting',
        createdAt: now,
        lastActivityAt: now
      },
      claudeSessionId: opts.resumeClaudeSessionId ?? id,
      titleLocked: false,
      scrollback: '',
      outBuf: '',
      screenTail: '',
      emitted: 0
    }
    this.live.set(id, l)
    this.persist()
    this.spawn(l, !!opts.resumeClaudeSessionId)
    return l.info
  }

  /** Start (or restart) the process behind an existing tab. */
  start(id: string) {
    const l = this.live.get(id)
    if (!l || l.proc) return
    this.spawn(l, transcriptExists(l.claudeSessionId))
  }

  private spawn(l: Live, resume: boolean) {
    const s = this.store.get()
    const claude = locateClaude(s.general.claudePath)
    if (!claude) {
      this.setInfo(l, { status: 'exited' })
      this.emit(
        'error',
        l.info.id,
        'Could not find the `claude` command. Install Claude Code (https://claude.com/claude-code) or set its path in Settings → General.'
      )
      return
    }

    const settingsFile = join(paths.run, `${l.info.id}.json`)
    const intercept = s.notifications.interceptPermissions !== 'never'
    writeFileSync(
      settingsFile,
      JSON.stringify(
        buildHookSettings({
          port: this.hookPort,
          token: this.hookToken,
          sessionId: l.info.id,
          permissionTimeoutSec: s.notifications.permissionTimeoutSec,
          interceptPermissions: intercept
        })
      )
    )

    const args = resume ? ['--resume', l.claudeSessionId] : ['--session-id', l.claudeSessionId]
    args.push('--settings', settingsFile, ...splitArgs(s.general.extraArgs))
    const target = spawnTarget(claude, args)
    const cwd = existsSync(l.info.cwd) ? l.info.cwd : process.env.HOME || process.env.USERPROFILE || process.cwd()

    let proc: pty.IPty
    try {
      proc = pty.spawn(target.file, target.args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd,
        env: {
          ...childEnv(),
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          FORCE_HYPERLINK: '1',
          HIVE_SESSION_ID: l.info.id
        }
      })
    } catch (err) {
      this.setInfo(l, { status: 'exited' })
      this.emit('error', l.info.id, `Failed to start claude: ${(err as Error).message}`)
      return
    }

    l.proc = proc
    this.setInfo(l, { status: 'starting', exitCode: undefined, pending: undefined })
    proc.onData((d) => this.onData(l, d))
    proc.onExit(({ exitCode }) => {
      if (l.proc !== proc) return
      l.proc = undefined
      this.flush(l)
      this.releaseHeld(l, {})
      this.setInfo(l, { status: 'exited', exitCode, pending: undefined })
    })
  }

  private onData(l: Live, d: string) {
    l.outBuf += d
    l.scrollback += d
    if (l.scrollback.length > SCROLLBACK_MAX) l.scrollback = l.scrollback.slice(-SCROLLBACK_MAX)
    if (!l.flushTimer) l.flushTimer = setTimeout(() => this.flush(l), 8)
    this.watchForTrustPrompt(l, d)
    // SessionStart can't use http hooks, so treat "the UI has drawn and gone quiet" as ready.
    if (l.info.status === 'starting') {
      if (l.startTimer) clearTimeout(l.startTimer)
      l.startTimer = setTimeout(() => {
        if (l.info.status === 'starting') this.setInfo(l, { status: 'idle' })
      }, 1200)
    }
  }

  private flush(l: Live) {
    if (l.flushTimer) clearTimeout(l.flushTimer)
    l.flushTimer = undefined
    if (!l.outBuf) return
    const chunk = l.outBuf
    l.outBuf = ''
    l.emitted += chunk.length
    this.emit('data', l.info.id, chunk, l.emitted)
  }

  /** Claude Code asks "Do you trust this folder?" the first time it runs somewhere. Its default answer is "No, exit". */
  private watchForTrustPrompt(l: Live, d: string) {
    if (l.trustAnswered || (l.info.status !== 'starting' && l.info.status !== 'idle')) return
    l.screenTail = (l.screenTail + d.replace(ANSI, '').replace(/\s+/g, '')).slice(-4000)
    const showing = l.screenTail.includes('Itrustthisfolder') && /Entertoconfirm/.test(l.screenTail.slice(-400))
    if (showing && !l.info.trustPrompt) this.setInfo(l, { trustPrompt: true })
  }

  answerTrust(id: string, trust: boolean) {
    const l = this.live.get(id)
    if (!l?.proc || !l.info.trustPrompt) return
    l.screenTail = ''
    l.trustAnswered = true
    this.setInfo(l, { trustPrompt: false })
    if (trust) {
      // Options are "No, exit" (selected) then "Yes, I trust this folder".
      l.proc.write('\x1b[B')
      setTimeout(() => l.proc?.write('\r'), 150)
    } else {
      l.proc.write('\x1b')
    }
  }

  close(id: string) {
    const l = this.live.get(id)
    if (!l) return
    this.releaseHeld(l, {})
    try {
      l.proc?.kill()
    } catch {
      /* already gone */
    }
    l.proc = undefined
    this.live.delete(id)
    rmSync(join(paths.run, `${id}.json`), { force: true })
    this.persist()
    this.emit('removed', id)
  }

  shutdown() {
    for (const l of this.live.values()) {
      this.releaseHeld(l, {})
      try {
        l.proc?.kill()
      } catch {
        /* ignore */
      }
    }
    this.persist()
  }

  // ---------- input ----------

  write(id: string, data: string) {
    this.live.get(id)?.proc?.write(data)
  }

  resize(id: string, cols: number, rows: number) {
    const p = this.live.get(id)?.proc
    if (p && cols > 0 && rows > 0) {
      try {
        p.resize(Math.floor(cols), Math.floor(rows))
      } catch {
        /* process exiting */
      }
    }
  }

  /** Types a prompt into Claude Code and submits it. Works while idle; queued by Claude while working. */
  sendPrompt(id: string, text: string): boolean {
    const l = this.live.get(id)
    if (!l?.proc || l.info.trustPrompt) return false
    const body = text.replace(/\r\n?/g, '\n')
    // Bracketed paste keeps newlines as newlines instead of submitting early.
    l.proc.write(BRACKET_START + body + BRACKET_END)
    setTimeout(() => l.proc?.write('\r'), 120)
    return true
  }

  interrupt(id: string) {
    const l = this.live.get(id)
    if (!l) return
    if (l.held) this.answerPermission(id, l.held.requestId, { behavior: 'deny', message: 'Stopped by user.', interrupt: true })
    else l.proc?.write('\x1b')
  }

  rename(id: string, title: string) {
    const l = this.live.get(id)
    if (!l) return
    l.titleLocked = true
    this.setInfo(l, { title: title.trim() || DEFAULT_TITLE })
    this.persist()
  }

  // ---------- permissions ----------

  answerPermission(id: string, requestId: string, answer: PermissionAnswer): boolean {
    const l = this.live.get(id)
    if (!l) return false
    if (l.held && l.held.requestId === requestId) {
      const out =
        answer.behavior === 'terminal'
          ? {}
          : answer.behavior === 'allow'
            ? permissionDecision('allow')
            : permissionDecision('deny', answer.message, answer.interrupt)
      this.releaseHeld(l, out)
      if (answer.behavior === 'terminal') {
        // Claude will now draw its own dialog; keep the badge but stop treating it as held.
        if (l.info.pending) this.setInfo(l, { pending: { ...l.info.pending, held: false } })
      } else {
        this.setInfo(l, { status: 'working', pending: undefined })
      }
      return true
    }
    // Not held by Hive: drive Claude Code's own dialog (Enter = default "Yes", Esc = "No").
    if (l.info.status === 'waiting_permission' && l.proc && answer.behavior !== 'terminal') {
      l.proc.write(answer.behavior === 'allow' ? '\r' : '\x1b')
      return true
    }
    return false
  }

  private releaseHeld(l: Live, out: unknown) {
    const h = l.held
    l.held = undefined
    h?.resolve(out)
  }

  // ---------- hooks ----------

  handleHook = async (req: HookRequest): Promise<unknown> => {
    const l = this.live.get(req.sessionId)
    if (!l) return {}
    const now = Date.now()
    if (typeof req.payload.session_id === 'string' && req.payload.session_id && req.payload.session_id !== l.claudeSessionId) {
      // /clear, /resume or a fork inside Claude switched conversations; follow it so restarts resume the right one.
      l.claudeSessionId = req.payload.session_id
      this.persist()
    }

    if (req.event === 'PermissionRequest') return this.holdPermission(l, req, now)

    const t = applyHook(l.info, req.event, req.payload, now, l.titleLocked)
    const titleChanged = t.session.title !== l.info.title
    l.info = t.session
    if (titleChanged) this.persist()
    this.emit('update', l.info)
    if (t.signal) this.emit('signal', l.info, t.signal)
    return {}
  }

  private holdPermission(l: Live, req: HookRequest, now: number): Promise<unknown> | unknown {
    const s = this.store.get().notifications
    const toolName = String(req.payload.tool_name ?? 'Tool')
    const pending: PendingPermission = {
      requestId: randomUUID(),
      toolName,
      summary: summarizeToolInput(toolName, req.payload.tool_input),
      toolInput: req.payload.tool_input,
      createdAt: now,
      held: true
    }
    const hold = s.interceptPermissions === 'always' || (s.interceptPermissions === 'away' && this.presence() === 'away')
    if (!hold) {
      // Let the terminal dialog handle it; the Notification hook will flag it.
      return {}
    }
    this.releaseHeld(l, {}) // only one outstanding prompt per session
    return new Promise((resolve) => {
      l.held = { requestId: pending.requestId, resolve }
      req.onAbort(() => {
        if (l.held?.requestId !== pending.requestId) return
        l.held = undefined
        // Claude Code stopped waiting (timeout or user acted in the terminal).
        if (l.info.pending?.requestId === pending.requestId) this.setInfo(l, { pending: { ...pending, held: false } })
      })
      this.setInfo(l, { status: 'waiting_permission', pending, lastActivityAt: now })
      this.emit('permission', l.info, pending)
    })
  }

  private setInfo(l: Live, patch: Partial<SessionInfo>) {
    l.info = { ...l.info, ...patch }
    this.emit('update', l.info)
  }
}

// Markers a parent Claude Code session sets for its own children. If Hive was launched from inside
// Claude Code they would leak into every tab (e.g. turning off transcript saving), so drop them.
const INHERITED_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
  'ELECTRON_RUN_AS_NODE'
]

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  for (const k of INHERITED_SESSION_VARS) delete env[k]
  return env
}

export function transcriptExists(claudeSessionId: string): boolean {
  try {
    for (const dir of readdirSync(paths.claudeProjects)) {
      if (existsSync(join(paths.claudeProjects, dir, `${claudeSessionId}.jsonl`))) return true
    }
  } catch {
    /* no projects dir yet */
  }
  return false
}

/** Splits "--model opus --add-dir \"C:/my dir\"" into argv, honouring double quotes. */
export function splitArgs(input: string | undefined): string[] {
  if (!input) return []
  const out: string[] = []
  for (const m of input.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2])
  return out
}
