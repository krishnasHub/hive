import { useMemo, useState } from 'react'
import type { SessionInfo } from '@shared/types'
import { Modal } from './Modal'
import { basename } from './Sidebar'

const RECENT_KEY = 'hive.recentFolders'

function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
  } catch {
    return []
  }
}

function saveRecent(dir: string) {
  try {
    const next = [dir, ...loadRecent().filter((d) => d !== dir)].slice(0, 12)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable */
  }
}

interface Props {
  sessions: SessionInfo[]
  defaultCwd: string
  onCreate(cwd: string, title?: string): void
  onClose(): void
}

export function NewSessionDialog({ sessions, defaultCwd, onCreate, onClose }: Props) {
  const recent = useMemo(() => {
    const all = [...loadRecent(), ...sessions.map((s) => s.cwd), defaultCwd]
    return [...new Set(all.filter(Boolean))].slice(0, 10)
  }, [sessions, defaultCwd])
  const [cwd, setCwd] = useState(recent[0] ?? defaultCwd)
  const [title, setTitle] = useState('')

  const create = (dir = cwd) => {
    if (!dir) return
    saveRecent(dir)
    onCreate(dir, title.trim() || undefined)
  }

  return (
    <Modal title="New Claude session" onClose={onClose}>
      <label className="field">
        <span>Project folder</span>
        <div className="row">
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} autoFocus />
          <button
            onClick={async () => {
              const d = await window.hive.app.pickFolder(cwd)
              if (d) setCwd(d)
            }}
          >
            Browse…
          </button>
        </div>
      </label>
      <label className="field">
        <span>Tab name (optional, defaults to your first prompt)</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
      </label>
      {recent.length > 0 && (
        <div className="field">
          <span>Recent</span>
          <div className="recent">
            {recent.map((d) => (
              <button key={d} className={`recent-item ${d === cwd ? 'selected' : ''}`} onClick={() => setCwd(d)} onDoubleClick={() => create(d)} title={d}>
                <strong>{basename(d)}</strong> <span className="muted">{d}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="row end">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={() => create()}>
          Start Claude
        </button>
      </div>
    </Modal>
  )
}
