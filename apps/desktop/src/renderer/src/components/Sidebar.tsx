import type { Presence, PresenceMode, SessionInfo } from '@shared/types'
import { StatusDot, statusLabel } from './StatusDot'

interface Props {
  sessions: SessionInfo[]
  activeId: string | null
  needsYou: Set<string>
  presence: { presence: Presence; mode: PresenceMode }
  onSelect(id: string): void
  onNew(): void
  onSearch(): void
  onSettings(): void
  onActivity(): void
  onPresence(mode: PresenceMode): void
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

export function Sidebar(p: Props) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">🐝</span> Hive
      </div>
      <button className="new-btn" onClick={p.onNew}>
        + New session
      </button>
      <div className="session-list">
        {p.sessions.map((s) => (
          <button key={s.id} className={`session-item ${s.id === p.activeId ? 'active' : ''}`} onClick={() => p.onSelect(s.id)} title={`${s.cwd}\n${statusLabel(s)}`}>
            <StatusDot session={s} attention={p.needsYou.has(s.id)} />
            <div className="session-text">
              <div className="session-title">{s.title}</div>
              <div className="session-sub">
                <span className="code">{s.shortCode}</span> {basename(s.cwd)} · {statusLabel(s)}
              </div>
            </div>
          </button>
        ))}
      </div>
      <div className="sidebar-footer">
        <div className="presence" title="When you're away, notifications also go to your phone">
          <span className={`presence-dot ${p.presence.presence}`} />
          <select value={p.presence.mode} onChange={(e) => p.onPresence(e.target.value as PresenceMode)}>
            <option value="auto">Auto ({p.presence.presence === 'away' ? 'away' : 'at desk'})</option>
            <option value="present">At my desk</option>
            <option value="away">Away: send to phone</option>
          </select>
        </div>
        <div className="footer-buttons">
          <button onClick={p.onSearch}>Search</button>
          <button onClick={p.onActivity}>Activity</button>
          <button onClick={p.onSettings}>Settings</button>
        </div>
      </div>
    </aside>
  )
}
