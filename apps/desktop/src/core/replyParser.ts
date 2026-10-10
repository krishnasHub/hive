// Turns a short chat reply ("yes", "no - use staging", "status", ...) into an action.

export type ReplyAction =
  | { type: 'approve'; followUp?: string }
  | { type: 'deny'; reason?: string }
  | { type: 'stop' }
  | { type: 'status' }
  | { type: 'text'; text: string }

const APPROVE = new Set(['yes', 'y', 'yep', 'yeah', 'yup', 'approve', 'approved', 'allow', 'ok', 'okay', 'go', 'go ahead', 'sure', '👍', '✅'])
const DENY = new Set(['no', 'n', 'nope', 'nah', 'deny', 'denied', 'reject', 'decline', '👎', '❌'])
const STOP = new Set(['stop', 'cancel', 'abort', 'interrupt', 'halt', '🛑'])
const STATUS = new Set(['status', '?', 'state', 'progress'])

/** Splits "yes, but skip seeds" into ["yes", "but skip seeds"]. */
function splitLead(text: string): [string, string] {
  const m = /^([^\s,.;:!\-–—]+(?:\s+ahead)?)[\s,.;:!\-–—]*(.*)$/su.exec(text)
  if (!m) return [text, '']
  return [m[1], m[2].trim()]
}

export function parseReply(raw: string, actionId?: string): ReplyAction {
  if (actionId === 'approve') return { type: 'approve' }
  if (actionId === 'deny') return { type: 'deny' }
  if (actionId === 'stop') return { type: 'stop' }
  if (actionId === 'status') return { type: 'status' }

  const text = raw.trim()
  const lower = text.toLowerCase()
  if (!text) return { type: 'status' }
  if (APPROVE.has(lower)) return { type: 'approve' }
  if (DENY.has(lower)) return { type: 'deny' }
  if (STOP.has(lower)) return { type: 'stop' }
  if (STATUS.has(lower)) return { type: 'status' }

  const [lead, rest] = splitLead(text)
  const leadLower = lead.toLowerCase()
  if (rest) {
    const followUp = rest.replace(/^((but|and|then|so)\s+)+/i, '').trim()
    if (APPROVE.has(leadLower)) return { type: 'approve', followUp: followUp || undefined }
    if (DENY.has(leadLower)) return { type: 'deny', reason: followUp || undefined }
  }
  return { type: 'text', text }
}

/** Extracts a leading session code: "H7K: run it" -> { code: 'H7K', rest: 'run it' }. */
export function extractSessionCode(raw: string, knownCodes: Iterable<string>): { code?: string; rest: string } {
  const m = /^\s*\[?#?([A-Za-z0-9]{3})\]?\s*[:>\-]\s*(.*)$/su.exec(raw) ?? /^\s*\[?#?([A-Za-z0-9]{3})\]?\s+(.*)$/su.exec(raw)
  if (!m) return { rest: raw }
  const code = m[1].toUpperCase()
  for (const k of knownCodes) if (k === code) return { code, rest: m[2] }
  return { rest: raw }
}
