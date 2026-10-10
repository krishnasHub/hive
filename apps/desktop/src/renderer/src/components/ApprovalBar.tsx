import type { SessionInfo } from '@shared/types'
import { focusTerminalSoon } from './TerminalView'

export function ApprovalBar({ session }: { session: SessionInfo }) {
  const p = session.pending!
  const answer = (a: 'allow' | 'deny' | 'terminal') => {
    void window.hive.sessions.answerPermission(session.id, p.requestId, a)
    focusTerminalSoon()
  }
  return (
    <div className="bar">
      <div className="bar-text">
        <div className="bar-title">Claude wants to use {p.toolName}</div>
        <code className="bar-detail">{p.summary}</code>
      </div>
      <div className="row">
        <button className="primary" onClick={() => answer('allow')}>
          Allow
        </button>
        <button onClick={() => answer('deny')}>Deny</button>
        <button className="ghost" onClick={() => answer('terminal')} title="Show Claude Code's own prompt, with options like 'don't ask again'">
          More options…
        </button>
      </div>
    </div>
  )
}

export function TrustBar({ session }: { session: SessionInfo }) {
  const answer = (trust: boolean) => {
    void window.hive.sessions.answerTrust(session.id, trust)
    focusTerminalSoon()
  }
  return (
    <div className="bar">
      <div className="bar-text">
        <div className="bar-title">First time in this folder. Do you trust it?</div>
        <code className="bar-detail">{session.cwd}</code>
        <div className="bar-sub">Claude will be able to read, edit and run files here. Only trust folders whose contents you know.</div>
      </div>
      <div className="row">
        <button className="primary" onClick={() => answer(true)}>
          Trust folder
        </button>
        <button onClick={() => answer(false)}>Cancel</button>
      </div>
    </div>
  )
}
