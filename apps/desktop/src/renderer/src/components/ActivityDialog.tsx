import { useEffect, useState } from 'react'
import type { ActivityEntry } from '@shared/types'
import { Modal } from './Modal'

export function ActivityDialog({ onClose }: { onClose(): void }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  useEffect(() => {
    void window.hive.activity.list().then((l) => setEntries([...l].reverse()))
    return window.hive.activity.onEntry((e) => setEntries((prev) => [e, ...prev]))
  }, [])
  return (
    <Modal title="Activity" onClose={onClose} wide>
      <p className="muted small">Notifications sent and every action taken from your phone. Also written to ~/.hive/logs/activity.log.</p>
      <div className="activity">
        {entries.length === 0 && <div className="muted">Nothing yet.</div>}
        {entries.map((e, i) => (
          <div key={i} className="activity-row">
            <span className="muted">{new Date(e.ts).toLocaleTimeString()}</span>
            <span className="code">{e.sessionCode ?? '—'}</span>
            <span>{e.text}</span>
          </div>
        ))}
      </div>
    </Modal>
  )
}
