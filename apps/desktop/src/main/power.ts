// Keeps the computer awake while Claude sessions work: blocks idle sleep, and optionally
// overrides the lid-close action (Windows power plan / Linux systemd inhibitor).
// Pure decisions and powercfg parsing live in core/power.ts.
import { EventEmitter } from 'node:events'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { powerMonitor, powerSaveBlocker } from 'electron'
import type { LidMode, PowerStatus } from '@shared/types'
import {
  LIDACTION,
  MAC_LID_MESSAGE,
  NO_LID_MESSAGE,
  SUB_BUTTONS,
  decide,
  engagedValues,
  lidSetCommands,
  parseLidQuery,
  parseLidState,
  type LidOverride,
  type LidState,
  type LidValues
} from '@core/power'

/** Keep the lid override this long after the last session stops, so it doesn't flap between turns. */
const RELEASE_DELAY_MS = 60_000
/** After a failed attempt, don't try the same thing again for this long (unless the setting changes). */
const RETRY_AFTER_MS = 10 * 60_000
const INHIBIT_SETTLE_MS = 1_000

const POWERCFG = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'powercfg.exe')
const QUERY_ARGS = ['/query', 'SCHEME_CURRENT', SUB_BUTTONS, LIDACTION]

interface Settings {
  keepAwake: boolean
  lidClosed: LidMode
}

export class PowerManager extends EventEmitter<{ status: [PowerStatus] }> {
  private readonly stateFile: string
  private readonly log: (text: string) => void
  private readonly platform = process.platform

  private active = 0
  private settings: Settings = { keepAwake: false, lidClosed: 'off' }
  private blockerId: number | null = null

  /** Lid override actually in effect. */
  private lid: LidOverride = 'none'
  /** Lid override we're heading to (equals `lid` when idle). */
  private want: LidOverride = 'none'
  private busy = false
  private releaseTimer?: NodeJS.Timeout
  private releaseDue = false
  private failure: { target: LidOverride; lidClosed: LidMode; at: number } | null = null

  private supported = this.platform === 'win32' || this.platform === 'linux'
  private message?: string = this.platform === 'darwin' ? MAC_LID_MESSAGE : undefined
  private probed = false
  /** Windows: lid values before Hive changed them. */
  private original: LidValues | null = null
  /** Linux: systemd-inhibit holding the lid switch. */
  private inhibitor: ChildProcess | null = null

  private listening = false
  private disposed = false
  private lastJson = ''
  private readonly onPowerSource = () => this.evaluate()

  constructor(opts: { stateFile: string; log(text: string): void }) {
    super()
    this.stateFile = opts.stateFile
    this.log = (t) => opts.log(`[power] ${t}`)
  }

  /** Call once at startup, before update(): restores a lid setting a crashed Hive left behind. */
  recover(): void {
    if (!existsSync(this.stateFile)) return
    let text = ''
    try {
      text = readFileSync(this.stateFile, 'utf8')
    } catch (e) {
      this.log(`could not read ${this.stateFile}: ${errText(e)}`)
    }
    const state = parseLidState(text)
    if (!state) {
      this.log(`ignoring unreadable lid state file: ${text.slice(0, 200)}`)
      this.deleteState()
      return
    }
    if (this.platform !== 'win32') {
      this.log('lid state file is from Windows; nothing to restore on this platform')
      this.deleteState()
      return
    }
    try {
      this.restoreWindowsSync(state)
      this.log(`restored lid action left by a previous run (scheme ${state.scheme}, AC ${state.ac}, DC ${state.dc})`)
    } catch (e) {
      // Keep the state file so the next start (or the next release) can try again.
      this.message = `Couldn't restore the lid setting from a previous run: ${errText(e)}`
      this.log(this.message)
    }
  }

  /** Re-evaluate. activeSessions = sessions that should keep the machine awake right now. */
  update(activeSessions: number, settings: Settings): void {
    if (this.disposed) return
    if (settings.lidClosed !== this.settings.lidClosed && this.failure) {
      // New setting: forget the old failure and let it try again.
      this.failure = null
      if (this.supported) this.message = undefined
    }
    this.active = Math.max(0, activeSessions)
    this.settings = { keepAwake: settings.keepAwake, lidClosed: settings.lidClosed }
    this.ensureListeners()
    this.probe()
    this.evaluate()
  }

  status(): PowerStatus {
    return {
      blocking: this.blockerId !== null,
      activeSessions: this.active,
      lid: {
        supported: this.supported,
        engaged: this.lid !== 'none',
        ...(this.message ? { message: this.message } : {})
      }
    }
  }

  /** App quit: release everything synchronously. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.releaseTimer) clearTimeout(this.releaseTimer)
    this.releaseTimer = undefined
    this.stopBlocker()
    if (this.listening) {
      powerMonitor.off('on-ac', this.onPowerSource)
      powerMonitor.off('on-battery', this.onPowerSource)
      this.listening = false
    }
    this.killInhibitor()
    if (this.platform === 'win32' && (this.original || existsSync(this.stateFile))) {
      try {
        const state = this.original ?? this.readState()
        if (state) this.restoreWindowsSync(state)
        else this.deleteState()
        this.log('restored lid action on quit')
      } catch (e) {
        this.log(`could not restore lid action on quit (will retry next start): ${errText(e)}`)
      }
    }
    this.lid = 'none'
    this.want = 'none'
  }

  // ---- evaluation ----

  private evaluate() {
    if (this.disposed) return
    const d = decide(this.active, this.settings, this.onBattery(), this.platform)

    if (d.blockIdle) this.startBlocker()
    else this.stopBlocker()

    let target: LidOverride = this.supported ? d.lid : 'none'
    if (target !== 'none') {
      this.releaseDue = false
      if (this.releaseTimer) clearTimeout(this.releaseTimer)
      this.releaseTimer = undefined
      if (this.blocked(target)) target = 'none'
    } else if (this.want !== 'none') {
      // Sessions merely went quiet: hold the override a little longer. Settings changes release now.
      const lazy = this.active === 0 && this.settings.keepAwake && this.settings.lidClosed !== 'off'
      if (lazy && !this.releaseDue) {
        target = this.want
        if (!this.releaseTimer) {
          this.releaseTimer = setTimeout(() => {
            this.releaseTimer = undefined
            this.releaseDue = true
            this.evaluate()
          }, RELEASE_DELAY_MS)
          this.releaseTimer.unref?.()
        }
      }
    }
    if (target === 'none' && this.want !== 'none' && this.blocked('none')) {
      // A release just failed; don't hammer powercfg on every update.
      target = this.want
    }
    if (target === 'none') {
      this.releaseDue = false
      if (this.releaseTimer) clearTimeout(this.releaseTimer)
      this.releaseTimer = undefined
    }

    if (target !== this.want) {
      this.want = target
      void this.pump()
    }
    this.emitStatus()
  }

  private blocked(target: LidOverride): boolean {
    const f = this.failure
    return !!f && f.target === target && f.lidClosed === this.settings.lidClosed && Date.now() - f.at < RETRY_AFTER_MS
  }

  /** Drive `lid` towards `want`, one OS change at a time. */
  private async pump() {
    if (this.busy) return
    this.busy = true
    try {
      while (!this.disposed && this.want !== this.lid) {
        const target = this.want
        try {
          await this.transition(target)
          if (target !== 'none' && this.lid === target) this.failure = null
        } catch (e) {
          this.failure = { target, lidClosed: this.settings.lidClosed, at: Date.now() }
          this.message =
            target === 'none'
              ? `Couldn't restore the lid setting: ${errText(e)}`
              : `Couldn't keep the computer awake with the lid closed: ${errText(e)}`
          this.log(this.message)
        }
        if (this.want !== 'none' && this.lid !== this.want && this.want === target) {
          // Failed or unsupported: stop trying until something changes.
          this.want = this.lid
        } else if (this.want === 'none' && this.lid !== 'none' && target === 'none') {
          // Release failed; leave it (state file lets recover()/dispose() fix it) instead of looping.
          this.want = this.lid
        }
        this.emitStatus()
      }
    } finally {
      this.busy = false
    }
  }

  private async transition(target: LidOverride) {
    if (this.platform === 'win32') {
      if (target === 'none') await this.releaseWindows()
      else await this.engageWindows(target)
    } else if (this.platform === 'linux') {
      if (target === 'none') {
        this.killInhibitor()
        this.lid = 'none'
        this.message = undefined
        this.log('lid switch released')
      } else {
        await this.startInhibitor()
        this.lid = 'inhibit'
        this.message = "Closing the lid won't suspend while sessions work"
        this.log('holding the lid switch (systemd-inhibit)')
      }
    }
  }

  // ---- idle sleep ----

  private startBlocker() {
    if (this.blockerId !== null && powerSaveBlocker.isStarted(this.blockerId)) return
    this.blockerId = powerSaveBlocker.start('prevent-app-suspension')
    console.log('[power] blocking idle sleep') // every turn; too chatty for Activity
  }

  private stopBlocker() {
    if (this.blockerId === null) return
    if (powerSaveBlocker.isStarted(this.blockerId)) powerSaveBlocker.stop(this.blockerId)
    this.blockerId = null
    console.log('[power] idle sleep allowed again')
  }

  // ---- Windows ----

  private probe() {
    if (this.probed || this.platform !== 'win32') return
    this.probed = true
    powercfg(QUERY_ARGS).then(
      (out) => {
        if (parseLidQuery(out) || this.lid !== 'none') return
        this.markNoLid()
        this.evaluate()
      },
      (e) => this.log(`powercfg query failed: ${errText(e)}`)
    )
  }

  private markNoLid() {
    this.supported = false
    this.message = NO_LID_MESSAGE
    this.log('no lid setting on this computer')
  }

  private async engageWindows(target: LidOverride) {
    if (!this.original) {
      const values = parseLidQuery(await powercfg(QUERY_ARGS))
      if (!values) {
        this.markNoLid()
        return
      }
      this.original = values
    }
    const original = this.original
    // Save the originals before touching anything, so a crash can be undone at next start.
    const state: LidState = { platform: 'win32', ...original, mode: target }
    mkdirSync(dirname(this.stateFile), { recursive: true })
    writeFileSync(this.stateFile, JSON.stringify(state))
    const v = engagedValues(original, target)
    try {
      for (const args of lidSetCommands(original.scheme, v.ac, v.dc)) await powercfg(args)
    } catch (e) {
      // Best effort: put back whatever may have been changed.
      try {
        for (const args of lidSetCommands(original.scheme, original.ac, original.dc)) await powercfg(args)
        this.deleteState()
        this.original = null
      } catch {
        // State file stays; recover() will try at next start.
      }
      this.lid = 'none'
      throw e
    }
    if (this.disposed) {
      // Quit raced with us; dispose() may already have restored, so do it again now.
      this.restoreWindowsSync(state)
      return
    }
    this.lid = target
    this.message =
      target === 'ac+dc'
        ? "Closing the lid won't sleep while sessions work"
        : "Closing the lid won't sleep while plugged in and sessions work"
    this.log(`lid action set to do nothing (${target}; was AC ${original.ac}, DC ${original.dc})`)
  }

  private async releaseWindows() {
    const o = this.original ?? this.readState()
    if (o) {
      for (const args of lidSetCommands(o.scheme, o.ac, o.dc)) await powercfg(args)
      this.log(`lid action restored (AC ${o.ac}, DC ${o.dc})`)
    }
    this.deleteState()
    this.original = null
    this.lid = 'none'
    if (this.supported) this.message = undefined
  }

  private restoreWindowsSync(o: LidValues) {
    for (const args of lidSetCommands(o.scheme, o.ac, o.dc)) {
      execFileSync(POWERCFG, args, { windowsHide: true, timeout: 15_000, stdio: 'pipe' })
    }
    this.deleteState()
    this.original = null
  }

  private readState(): LidState | null {
    try {
      return parseLidState(readFileSync(this.stateFile, 'utf8'))
    } catch {
      return null
    }
  }

  private deleteState() {
    try {
      unlinkSync(this.stateFile)
    } catch {
      // already gone
    }
  }

  // ---- Linux ----

  private onBattery(): boolean {
    if (this.platform !== 'linux') return false
    try {
      return powerMonitor.isOnBatteryPower()
    } catch {
      return false
    }
  }

  private ensureListeners() {
    if (this.listening || this.platform !== 'linux') return
    this.listening = true
    powerMonitor.on('on-ac', this.onPowerSource)
    powerMonitor.on('on-battery', this.onPowerSource)
  }

  /**
   * systemd-inhibit runs `cat` on a stdin pipe we never write to: when Hive exits (even by crashing)
   * the pipe closes, cat ends and the inhibitor lock goes with it, so nothing is left behind.
   */
  private startInhibitor(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      let stderr = ''
      let child: ChildProcess
      try {
        child = spawn(
          'systemd-inhibit',
          ['--what=handle-lid-switch:sleep:idle', '--who=Hive', '--why=Claude sessions are working', '--mode=block', 'cat'],
          { stdio: ['pipe', 'ignore', 'pipe'] }
        )
      } catch (e) {
        reject(e)
        return
      }
      child.stdin?.on('error', () => {})
      child.stderr?.on('data', (d) => {
        stderr += String(d)
      })
      const fail = (why: string) => {
        if (settled) return
        settled = true
        reject(new Error(why))
      }
      child.on('error', (e: NodeJS.ErrnoException) =>
        fail(e.code === 'ENOENT' ? 'systemd-inhibit is not available on this system' : e.message)
      )
      child.on('exit', (code, signal) => {
        if (!settled) {
          fail(stderr.trim() || `systemd-inhibit exited (${code ?? signal})`)
          return
        }
        if (this.inhibitor !== child) return
        // Died on its own while held.
        this.inhibitor = null
        this.lid = 'none'
        this.want = 'none'
        this.failure = { target: 'inhibit', lidClosed: this.settings.lidClosed, at: Date.now() }
        this.message = `The lid override stopped unexpectedly: ${stderr.trim() || `exit ${code ?? signal}`}`
        this.log(this.message)
        this.emitStatus()
      })
      setTimeout(() => {
        if (settled) return
        settled = true
        if (this.disposed) {
          child.stdin?.end()
          child.kill()
          reject(new Error('quitting'))
          return
        }
        this.inhibitor = child
        resolve()
      }, INHIBIT_SETTLE_MS)
    })
  }

  private killInhibitor() {
    const child = this.inhibitor
    if (!child) return
    this.inhibitor = null
    try {
      child.stdin?.end()
      child.kill()
    } catch {
      // already gone
    }
  }

  // ---- status ----

  private emitStatus() {
    const s = this.status()
    const json = JSON.stringify(s)
    if (json === this.lastJson) return
    this.lastJson = json
    this.emit('status', s)
  }
}

function powercfg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(POWERCFG, args, { windowsHide: true, timeout: 15_000 }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout))
      const out = `${String(stdout)} ${String(stderr)}`.trim().replace(/\s+/g, ' ')
      const denied = /access|denied|privilege|0x5\b/i.test(out)
      reject(
        new Error(
          `powercfg ${args[0]} failed${out ? `: ${out}` : ''}` +
            (denied ? ' (this may need an administrator account or be blocked by policy)' : '')
        )
      )
    })
  })
}

function errText(e: unknown): string {
  if (e && typeof e === 'object' && 'stderr' in e) {
    const s = String((e as { stderr?: unknown }).stderr ?? '').trim()
    if (s) return s
  }
  return e instanceof Error ? e.message : String(e)
}
