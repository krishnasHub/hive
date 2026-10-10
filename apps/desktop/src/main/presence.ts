// Are you at the computer? Drives whether notifications go to your phone.
import { EventEmitter } from 'node:events'
import { powerMonitor } from 'electron'
import type { Presence, PresenceMode } from '@shared/types'

export class PresenceTracker extends EventEmitter<{ change: [Presence] }> {
  mode: PresenceMode = 'auto'
  private locked = false
  private last: Presence = 'present'
  private timer?: NodeJS.Timeout

  constructor(private awayAfterSec: () => number) {
    super()
  }

  start() {
    const flag = (v: boolean) => () => {
      this.locked = v
      this.check()
    }
    powerMonitor.on('lock-screen', flag(true))
    powerMonitor.on('unlock-screen', flag(false))
    powerMonitor.on('suspend', flag(true))
    powerMonitor.on('resume', flag(false))
    this.timer = setInterval(() => this.check(), 5_000)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  setMode(mode: PresenceMode) {
    this.mode = mode
    this.check()
  }

  get(): Presence {
    if (this.mode !== 'auto') return this.mode
    if (this.locked) return 'away'
    return powerMonitor.getSystemIdleTime() >= this.awayAfterSec() ? 'away' : 'present'
  }

  private check() {
    const now = this.get()
    if (now !== this.last) {
      this.last = now
      this.emit('change', now)
    }
  }
}
