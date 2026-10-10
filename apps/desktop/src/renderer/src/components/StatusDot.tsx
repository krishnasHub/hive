import type { SessionInfo } from '@shared/types'

export function statusLabel(s: SessionInfo): string {
  switch (s.status) {
    case 'dormant':
      return 'paused'
    case 'starting':
      return 'starting'
    case 'idle':
      return 'ready'
    case 'working':
      return 'working'
    case 'waiting_permission':
      return 'needs permission'
    case 'waiting_input':
      return 'waiting for you'
    case 'exited':
      return 'exited'
  }
}

export function StatusDot({ session, attention }: { session: SessionInfo; attention?: boolean }) {
  return <span className={`status-dot s-${session.status} ${attention ? 'attention' : ''}`} aria-label={statusLabel(session)} />
}
