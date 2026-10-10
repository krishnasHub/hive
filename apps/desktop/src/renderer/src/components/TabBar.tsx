import { useState } from 'react'
import type { SessionInfo } from '@shared/types'
import { StatusDot } from './StatusDot'

interface Props {
  sessions: SessionInfo[]
  activeId: string | null
  needsYou: Set<string>
  onSelect(id: string): void
  onClose(id: string): void
  onNew(): void
  onRename(id: string, title: string): void
}

export function TabBar(p: Props) {
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <div className="tabbar" role="tablist">
      {p.sessions.map((s) => (
        <div
          key={s.id}
          role="tab"
          aria-selected={s.id === p.activeId}
          className={`tab ${s.id === p.activeId ? 'active' : ''}`}
          onClick={() => p.onSelect(s.id)}
          onDoubleClick={() => setEditing(s.id)}
          onAuxClick={(e) => e.button === 1 && p.onClose(s.id)}
          title={`${s.title} — ${s.cwd}\nDouble-click to rename`}
        >
          <StatusDot session={s} attention={p.needsYou.has(s.id)} />
          {editing === s.id ? (
            <input
              autoFocus
              defaultValue={s.title}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                p.onRename(s.id, e.target.value)
                setEditing(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditing(null)
              }}
            />
          ) : (
            <span className="tab-title">{s.title}</span>
          )}
          <span className="tab-code">{s.shortCode}</span>
          <button
            className="tab-close"
            aria-label="Close tab"
            onClick={(e) => {
              e.stopPropagation()
              p.onClose(s.id)
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button className="tab-new" onClick={p.onNew} aria-label="New session">
        +
      </button>
    </div>
  )
}
