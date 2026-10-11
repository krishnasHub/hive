// The assistant: takes items from source plugins (Gmail, Slack), applies VIP/mute rules, asks Claude
// (`claude -p`, no tools) which ones matter, and raises alerts through the NotificationRouter.
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AssistantItem, AssistantStats } from '@shared/types'
import {
  alertMessage,
  isMuteReply,
  normalizeItem,
  parseTriageOutput,
  prefilter,
  senderKey,
  TRIAGE_SCHEMA,
  triagePrompt,
  triageSystemPrompt
} from '@core/assistant'
import type { NotificationRouter } from '@core/notificationRouter'
import { locateClaude } from './claudeLocator'
import { paths } from './paths'
import { childEnv } from './sessionManager'
import { writeJsonAtomic, type SettingsStore } from './store'

const MAX_ITEMS = 300
const MAX_SEEN = 5000
const BATCH = 12
const DEBOUNCE_MS = 4000
const TRIAGE_TIMEOUT_MS = 120_000
/** A runaway source (or a very busy Slack) shouldn't burn through your Claude usage. */
const DAILY_TRIAGE_LIMIT = 400
/** Text kept on disk per item; the full text is only needed while triage is pending. */
const STORED_TEXT = 600

interface Persisted {
  items: AssistantItem[]
  seen: string[]
  day: string
  triagedToday: number
  alertsToday: number
  lastRunAt?: number
  lastError?: string
}

export interface AssistantDeps {
  store: SettingsStore
  router: NotificationRouter
  newId(): string
  log(text: string): void
}

const today = () => new Date().toISOString().slice(0, 10)

export class Assistant extends EventEmitter<{ change: [] }> {
  private items: AssistantItem[] = [] // newest first
  private seen = new Set<string>()
  private queue: AssistantItem[] = []
  private stats: Omit<Persisted, 'items' | 'seen'> = { day: today(), triagedToday: 0, alertsToday: 0 }
  private timer?: NodeJS.Timeout
  private saveTimer?: NodeJS.Timeout
  private proc?: ChildProcess
  private running = false

  constructor(private d: AssistantDeps) {
    super()
  }

  load() {
    try {
      if (!existsSync(paths.assistant)) return
      const p = JSON.parse(readFileSync(paths.assistant, 'utf8')) as Persisted
      this.items = Array.isArray(p.items) ? p.items.slice(0, MAX_ITEMS) : []
      this.seen = new Set(Array.isArray(p.seen) ? p.seen : [])
      this.stats = { day: p.day, triagedToday: p.triagedToday ?? 0, alertsToday: p.alertsToday ?? 0, lastRunAt: p.lastRunAt, lastError: p.lastError }
    } catch (err) {
      this.d.log(`Assistant: could not read its state (${(err as Error).message}); starting fresh`)
    }
    // Hive quit mid-triage: try those again.
    for (const it of this.items) if (it.verdict === 'pending') this.queue.push(it)
    if (this.queue.length) this.schedule()
  }

  // ---------- queries ----------

  list(): AssistantItem[] {
    return this.items
  }

  getStats(): AssistantStats {
    this.rollDay()
    const { triagedToday, alertsToday, lastRunAt, lastError } = this.stats
    return { triagedToday, alertsToday, lastRunAt, lastError }
  }

  /** Still worth sending to the phone? False once you've looked at it in the Inbox. */
  isPending(key: string): boolean {
    const it = this.items.find((i) => i.key === key)
    return !!it && !it.seen
  }

  // ---------- input from source plugins ----------

  ingest(sourceId: string, sourceLabel: string, raws: unknown[]) {
    const now = Date.now()
    const settings = this.d.store.get().assistant
    let changed = false
    for (const raw of raws.slice(0, 100)) {
      const it = normalizeItem(raw, sourceId, sourceLabel, now)
      if (!it || this.seen.has(it.key)) continue
      this.remember(it.key)
      this.items.unshift(it)
      changed = true
      switch (prefilter(it, settings)) {
        case 'muted':
          it.verdict = 'muted'
          it.reason = 'Sender is on your never-alert list'
          break
        case 'paused':
          it.verdict = 'paused'
          it.reason = 'Alerts were paused'
          break
        case 'vip':
          it.verdict = 'vip'
          it.reason = 'Sender is on your always-alert list'
          // Still goes through Claude for a summary (it alerts whatever Claude thinks); paused means no Claude.
          if (settings.paused) this.raise(it)
          else this.queue.push(it)
          break
        case 'triage':
          this.queue.push(it)
      }
    }
    if (!changed) return
    this.items.length = Math.min(this.items.length, MAX_ITEMS)
    if (this.queue.length) this.schedule()
    this.changed()
  }

  // ---------- actions ----------

  muteSender(sender: string) {
    const s = this.d.store.get().assistant
    const key = sender.trim().toLowerCase()
    if (!key || s.mutedSenders.some((m) => m.trim().toLowerCase() === key)) return
    this.d.store.update({ assistant: { ...s, mutedSenders: [...s.mutedSenders, key] } })
    this.d.log(`Assistant: muted ${key}`)
    this.changed()
  }

  markAllSeen() {
    let changed = false
    for (const it of this.items) {
      if (!it.seen) {
        it.seen = true
        changed = true
      }
    }
    if (changed) this.changed()
  }

  retryErrors() {
    for (const it of this.items) {
      if (it.verdict === 'error' && !this.queue.includes(it)) {
        it.verdict = 'pending'
        it.reason = undefined
        this.queue.push(it)
      }
    }
    if (this.queue.length) this.schedule(0)
    this.changed()
  }

  /** A reply in an alert's thread on your phone. Returns the acknowledgement to send back. */
  handleReply(alertKey: string, text: string, actionId?: string): string {
    const it = this.items.find((i) => i.key === alertKey)
    if (!it) return 'That alert is too old to act on.'
    it.seen = true
    this.changed()
    const who = it.fromName || it.from
    if (isMuteReply(text, actionId)) {
      this.muteSender(senderKey(it))
      return `🔇 Muted ${who}. You won't get alerts about them any more (undo in Hive → Settings → Assistant).`
    }
    return `This is a ${it.sourceLabel} alert, not a Claude session, so your reply wasn't sent anywhere. Reply "mute" to stop alerts from ${who}.`
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.proc?.kill()
    this.flushSave()
  }

  // ---------- triage ----------

  private schedule(ms = DEBOUNCE_MS) {
    if (this.timer || this.running) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.runTriage()
    }, ms)
  }

  private async runTriage() {
    if (this.running || !this.queue.length) return
    this.rollDay()
    const settings = this.d.store.get().assistant
    const batch = this.queue.splice(0, BATCH)
    if (settings.paused || this.stats.triagedToday >= DAILY_TRIAGE_LIMIT) {
      for (const it of batch) {
        if (it.verdict === 'vip') {
          this.raise(it)
          continue
        }
        it.verdict = 'paused'
        it.reason = settings.paused ? 'Alerts were paused' : `Daily limit of ${DAILY_TRIAGE_LIMIT} checks reached`
      }
      this.changed()
      if (this.queue.length) this.schedule(0)
      return
    }

    this.running = true
    try {
      const verdicts = parseTriageOutput(await this.callClaude(batch, settings.interests, settings.model), batch.length)
      this.stats.triagedToday += batch.length
      this.stats.lastRunAt = Date.now()
      this.stats.lastError = undefined
      batch.forEach((it, i) => {
        const v = verdicts.get(i)
        it.triagedAt = Date.now()
        if (it.verdict === 'vip') {
          // Always-alert senders alert regardless; Claude only adds the summary and quip.
          it.summary = v?.summary || undefined
          it.quip = v?.quip || undefined
          this.raise(it)
          return
        }
        if (!v) {
          it.verdict = 'error'
          it.reason = 'Claude skipped this one'
          return
        }
        it.reason = v.reason
        it.summary = v.summary
        it.quip = v.quip || undefined
        it.verdict = v.important ? 'important' : 'not_important'
        // The rules may have changed while it waited (e.g. you muted the sender from your phone).
        if (v.important && prefilter(it, this.d.store.get().assistant) !== 'muted') this.raise(it)
      })
    } catch (err) {
      const message = (err as Error).message
      this.stats.lastError = message
      for (const it of batch) {
        if (it.verdict === 'vip') {
          this.raise(it) // an always-alert sender still alerts, just without a summary
          continue
        }
        it.verdict = 'error'
        it.reason = message
      }
      this.d.log(`Assistant: triage failed: ${message}`)
    } finally {
      this.running = false
      this.changed()
      if (this.queue.length) this.schedule(1000)
    }
  }

  private callClaude(batch: AssistantItem[], interests: string, model: string): Promise<string> {
    const claude = locateClaude(this.d.store.get().general.claudePath)
    if (!claude) return Promise.reject(new Error('Could not find the claude command'))
    const promptFile = join(paths.assistantRun, 'system-prompt.txt')
    const settingsFile = join(paths.assistantRun, 'settings.json')
    writeFileSync(promptFile, triageSystemPrompt(interests))
    writeFileSync(settingsFile, JSON.stringify({ disableAllHooks: true }))
    // No tools, no MCP servers, no user/project settings or hooks, nothing saved: Claude only reads and classifies.
    const args = [
      '-p',
      '--model',
      model || 'haiku',
      '--tools',
      '',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--settings',
      settingsFile,
      '--no-session-persistence',
      '--output-format',
      'json',
      '--system-prompt-file',
      promptFile
    ]
    const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(claude)
    // JSON on a cmd.exe command line gets mangled; .cmd installs fall back to the prompt's JSON instructions.
    if (!viaShell) args.push('--json-schema', JSON.stringify(TRIAGE_SCHEMA))

    return new Promise((resolve, reject) => {
      const proc = spawn(viaShell ? process.env.ComSpec || 'cmd.exe' : claude, viaShell ? ['/d', '/s', '/c', claude, ...args] : args, {
        cwd: paths.assistantRun,
        env: childEnv(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      this.proc = proc
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('claude took too long to answer'))
      }, TRIAGE_TIMEOUT_MS)
      proc.stdout!.on('data', (d) => (out += d))
      proc.stderr!.on('data', (d) => (err += d))
      proc.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        this.proc = undefined
        if (out.trim()) resolve(out)
        else reject(new Error(`claude exited with code ${code}${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}`))
      })
      proc.stdin!.end(triagePrompt(batch))
    })
  }

  private raise(it: AssistantItem) {
    this.rollDay()
    this.stats.alertsToday++
    this.d.log(`📬 ${it.sourceLabel} alert: ${it.fromName || it.from}${it.subject ? ` · ${it.subject}` : ''}${it.reason ? ` (${it.reason})` : ''}`)
    this.d.router.alert(alertMessage(this.d.newId(), it), it.key)
  }

  // ---------- bookkeeping ----------

  private remember(key: string) {
    this.seen.add(key)
    if (this.seen.size > MAX_SEEN) {
      const drop = this.seen.size - MAX_SEEN
      let i = 0
      for (const k of this.seen) {
        if (i++ >= drop) break
        this.seen.delete(k)
      }
    }
  }

  private rollDay() {
    const d = today()
    if (this.stats.day !== d) this.stats = { ...this.stats, day: d, triagedToday: 0, alertsToday: 0 }
  }

  private changed() {
    this.emit('change')
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.flushSave(), 1000)
  }

  private flushSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    const items = this.items.map((it) => (it.verdict === 'pending' ? it : { ...it, text: it.text.slice(0, STORED_TEXT) }))
    try {
      writeJsonAtomic(paths.assistant, { items, seen: [...this.seen], ...this.stats } satisfies Persisted)
    } catch (err) {
      console.error('[hive] could not save assistant state', err)
    }
  }
}
