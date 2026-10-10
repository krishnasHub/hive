import { useState } from 'react'
import { Modal } from './Modal'
import { basename } from '../recent'

interface Props {
  recent: string[]
  defaultCwd: string
  onCreate(cwd: string, title?: string): void
  onClose(): void
}

export function NewSessionDialog({ recent, defaultCwd, onCreate, onClose }: Props) {
  const [cwd, setCwd] = useState(defaultCwd)
  const [title, setTitle] = useState('')

  const create = (dir = cwd) => {
    if (dir.trim()) onCreate(dir.trim(), title.trim() || undefined)
  }

  return (
    <Modal title="New Claude session" onClose={onClose}>
      <label className="field">
        <span>Project folder</span>
        <div className="row">
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} autoFocus spellCheck={false} />
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
        <span>Tab name (optional; defaults to your first prompt)</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
      </label>
      {recent.length > 0 && (
        <div className="field">
          <span>Recent</span>
          <div className="recent">
            {recent.slice(0, 10).map((d) => (
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
