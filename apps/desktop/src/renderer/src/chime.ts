// Synthesized chimes (no audio files): a bright two-note rise when Claude needs you, a soft fall when it finished.
import type { AttentionKind } from '@core/attention'

let ctx: AudioContext | undefined

function bell(ac: AudioContext, freq: number, at: number, volume: number, length = 1.1) {
  // A bell is a decaying fundamental plus a quieter, faster-decaying overtone.
  for (const [mult, gainScale, decay] of [
    [1, 1, length],
    [2.76, 0.25, length * 0.45]
  ] as const) {
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq * mult
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(volume * gainScale, at + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + decay)
    osc.connect(gain).connect(ac.destination)
    osc.start(at)
    osc.stop(at + decay + 0.05)
  }
}

export function playChime(kind: AttentionKind, volume = 0.6) {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    const v = Math.max(0, Math.min(1, volume)) * 0.35
    const t = ctx.currentTime + 0.02
    if (kind === 'needs_you') {
      bell(ctx, 880, t, v) // A5
      bell(ctx, 1318.5, t + 0.14, v) // E6
    } else {
      bell(ctx, 1046.5, t, v * 0.8) // C6
      bell(ctx, 784, t + 0.16, v * 0.8, 1.4) // G5
    }
  } catch {
    /* audio unavailable */
  }
}
