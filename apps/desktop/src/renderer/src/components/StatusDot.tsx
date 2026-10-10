import type { SessionInfo } from '@shared/types'

export function statusLabel(s: SessionInfo): string {
  if (s.trustPrompt) return 'needs your answer'
  switch (s.status) {
    case 'dormant':
      return 'paused'
    case 'starting':
      return 'starting'
    case 'idle':
      return 'done'
    case 'working':
      return 'working'
    case 'waiting_permission':
      return 'needs permission'
    case 'waiting_input':
      return 'needs your answer'
    case 'exited':
      return 'exited'
  }
}

/** green = done, orange = working, red = Claude needs more from you, gray = not running. */
export type DotColor = 'done' | 'working' | 'needs' | 'off'

export function dotColor(s: SessionInfo): DotColor {
  if (s.trustPrompt || s.status === 'waiting_permission' || s.status === 'waiting_input') return 'needs'
  if (s.status === 'working' || s.status === 'starting') return 'working'
  if (s.status === 'idle') return 'done'
  return 'off'
}

export function StatusDot({ session, attention }: { session: SessionInfo; attention?: boolean }) {
  // `attention`: something here you haven't looked at yet; the dot gets a halo.
  return <span className={`status-dot d-${dotColor(session)} ${attention ? 'attention' : ''}`} role="img" aria-label={statusLabel(session)} />
}
