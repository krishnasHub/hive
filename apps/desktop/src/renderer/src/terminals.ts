// Routes PTY output to xterm instances, splicing scrollback and live data without duplicates.
type Sink = { ready: boolean; snapshotEnd: number; write: (d: string) => void }

const sinks = new Map<string, Sink>()
const pending = new Map<string, [string, number][]>()
const MAX_PENDING = 2000

let wired = false
export function wireTerminalData() {
  if (wired) return
  wired = true
  window.hive.sessions.onData((id, data, end) => {
    const sink = sinks.get(id)
    if (sink?.ready) {
      if (end > sink.snapshotEnd) sink.write(data)
      return
    }
    const q = pending.get(id) ?? []
    q.push([data, end])
    if (q.length > MAX_PENDING) q.shift()
    pending.set(id, q)
  })
}

/** Attach a terminal: replay what happened so far, then stream. */
export async function attachTerminal(id: string, write: (d: string) => void): Promise<() => void> {
  const sink: Sink = { ready: false, snapshotEnd: 0, write }
  sinks.set(id, sink)
  const { text, end } = await window.hive.sessions.scrollback(id)
  if (sinks.get(id) !== sink) return () => {}
  if (text) write(text)
  sink.snapshotEnd = end
  for (const [d, e] of pending.get(id) ?? []) if (e > end) write(d)
  pending.delete(id)
  sink.ready = true
  return () => {
    if (sinks.get(id) === sink) sinks.delete(id)
  }
}
