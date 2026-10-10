// Which sessions have something you haven't looked at yet. Drives the chime, the taskbar badge and tab dots.
import type { SessionInfo } from '../shared/types'

export type AttentionKind = 'needs_you' | 'update'

/**
 * A session needs attention when Claude is waiting on you, or when it finished a turn you haven't seen.
 * The tab you're looking at (window focused) never counts.
 * `seen[id]` is the lastActivityAt of that session when you last looked at it.
 */
export function attentionMap(
  sessions: SessionInfo[],
  activeId: string | null,
  windowFocused: boolean,
  seen: Record<string, number>
): Map<string, AttentionKind> {
  const out = new Map<string, AttentionKind>()
  for (const s of sessions) {
    if (s.id === activeId && windowFocused) continue
    if (s.status === 'waiting_permission' || s.status === 'waiting_input') out.set(s.id, 'needs_you')
    else if (s.status === 'idle' && s.lastActivityAt > (seen[s.id] ?? s.createdAt + 2000)) out.set(s.id, 'update')
  }
  return out
}

/** Sessions that just started needing attention (to chime once per new event, not on every render). */
export function newlyNeedingAttention(prev: Map<string, AttentionKind>, next: Map<string, AttentionKind>): AttentionKind | null {
  let result: AttentionKind | null = null
  for (const [id, kind] of next) {
    if (prev.get(id) === kind) continue
    if (kind === 'needs_you') return 'needs_you'
    result = 'update'
  }
  return result
}
