import { Fragment, useEffect, useState } from 'react'
import type { IndexStatus, SearchHit } from '@shared/types'
import { Modal } from './Modal'
import { basename } from './Sidebar'

/** Snippets mark matches with \u0001…\u0002; render them as <mark> without using innerHTML. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\u0001[^\u0002]*\u0002)/g)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('\u0001') ? <mark key={i}>{p.slice(1, -1)}</mark> : <Fragment key={i}>{p}</Fragment>
      )}
    </>
  )
}

function when(ts: string): string {
  const d = new Date(ts)
  return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function SearchDialog({ onResume, onClose }: { onResume(hit: SearchHit): void; onClose(): void }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [status, setStatus] = useState<IndexStatus | null>(null)

  useEffect(() => {
    void window.hive.history.status().then(setStatus)
    return window.hive.history.onStatus(setStatus)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void window.hive.history.search(q).then(setHits), 120)
    return () => clearTimeout(t)
  }, [q, status?.sessions])

  return (
    <Modal title="Search past sessions" onClose={onClose} wide>
      <input className="search-input" placeholder="Search everything you and Claude have said…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="muted small">
        {status?.error
          ? status.error
          : status
            ? `${status.sessions.toLocaleString()} sessions · ${status.messages.toLocaleString()} messages indexed${status.indexing ? ' · indexing…' : ''}`
            : 'Loading…'}
        {' · '}
        <button className="link" onClick={() => void window.hive.history.reindex()}>
          Re-index
        </button>
      </div>
      <div className="hits">
        {!q && hits.length > 0 && <div className="muted small">Recent sessions</div>}
        {hits.map((h, i) => (
          <button key={`${h.sessionId}-${i}`} className="hit" onClick={() => onResume(h)} title="Resume this conversation in a new tab">
            <div className="hit-head">
              <strong>{h.title || h.sessionId.slice(0, 8)}</strong>
              <span className="muted">
                {basename(h.cwd)} · {when(h.ts)} · {h.role}
              </span>
            </div>
            <div className="hit-snippet">
              <Snippet text={h.snippet} />
            </div>
          </button>
        ))}
        {q && hits.length === 0 && <div className="muted">No matches.</div>}
      </div>
    </Modal>
  )
}
