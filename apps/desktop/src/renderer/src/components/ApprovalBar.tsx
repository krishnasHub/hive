import type { SessionInfo } from '@shared/types'
import { focusTerminalSoon } from './TerminalView'

export function ApprovalBar({ session }: { session: SessionInfo }) {
  const p = session.pending!
  const answer = (a: 'allow' | 'deny' | 'terminal') => {
    void window.hive.sessions.answerPermission(session.id, p.requestId, a)
    focusTerminalSoon()
  }
  return (
    <div className="approval">
      <div className="approval-text">
        <div className="approval-title">🔐 Claude wants to use {p.toolName}</div>
        <code className="approval-detail">{p.summary}</code>
      </div>
      <div className="row">
        <button className="primary" onClick={() => answer('allow')}>
          Allow
        </button>
        <button className="danger" onClick={() => answer('deny')}>
          Deny
        </button>
        <button onClick={() => answer('terminal')} title="Show Claude Code's own prompt, with options like 'don't ask again'">
          More options…
        </button>
      </div>
    </div>
  )
}
