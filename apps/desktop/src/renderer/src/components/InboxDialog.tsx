// Inbox: what source plugins (Gmail, Slack, ...) handed to the assistant, and what Claude made of each item.
import { useEffect, useRef, useState } from 'react'
import type { AssistantItem, AssistantStats, AssistantVerdict } from '@shared/types'
import { Modal } from './Modal'

export const isAlert = (i: AssistantItem) => i.verdict === 'important' || i.verdict === 'vip'

/** "just now", "5 min ago", "3 h ago", then a date. */
export function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function statsLine(st: AssistantStats | null): string {
  if (!st) return 'Loading…'
  return [
    `${st.triagedToday} checked today`,
    `${st.alertsToday} alert${st.alertsToday === 1 ? '' : 's'} today`,
    st.lastRunAt ? `last check ${ago(st.lastRunAt)}` : 'not run yet'
  ].join(' · ')
}

export function useAssistantStats() {
  const [stats, setStats] = useState<AssistantStats | null>(null)
  useEffect(() => {
    const load = () => void window.hive.assistant.stats().then(setStats)
    load()
    return window.hive.assistant.onChange(load)
  }, [])
  return stats
}

const VERDICT_LABEL: Record<AssistantVerdict, string> = {
  important: 'Important',
  vip: 'VIP',
  not_important: 'not important',
  muted: 'muted',
  paused: 'paused',
  pending: 'pending',
  error: 'error'
}

type Filter = 'important' | 'all'

export function InboxDialog({ onClose, onOpenPlugins }: { onClose(): void; onOpenPlugins(): void }) {
  const [items, setItems] = useState<AssistantItem[] | null>(null)
  const [filter, setFilter] = useState<Filter>('important')
  const [busy, setBusy] = useState(false)
  const stats = useAssistantStats()
  // Items that were unseen when the dialog opened (or arrived while it is open) keep a "new" mark until it closes.
  const fresh = useRef(new Set<string>())

  useEffect(() => {
    const load = () =>
      void window.hive.assistant.list().then((list) => {
        const unseen = list.filter((i) => !i.seen)
        unseen.forEach((i) => fresh.current.add(i.key))
        setItems(list)
        // You're looking at the Inbox, so whatever is in it counts as seen.
        if (unseen.length) void window.hive.assistant.markAllSeen()
      })
    load()
    return window.hive.assistant.onChange(load)
  }, [])

  const all = items ?? []
  const important = all.filter(isAlert)
  const shown = filter === 'important' ? important : all
  const errors = all.filter((i) => i.verdict === 'error').length

  return (
    <Modal title="Inbox" onClose={onClose} wide>
      <div className="inbox-top">
        <span className="muted small">
          {statsLine(stats)}
          {stats?.lastError && <span className="error"> · {stats.lastError}</span>}
        </span>
        {errors > 0 && (
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              await window.hive.assistant.retryErrors().finally(() => setBusy(false))
            }}
          >
            Retry failed ({errors})
          </button>
        )}
      </div>

      <div className="tabs">
        {(['important', 'all'] as Filter[]).map((f) => (
          <button key={f} className={filter === f ? 'selected' : ''} onClick={() => setFilter(f)}>
            {f === 'important' ? `Important (${important.length})` : `All (${all.length})`}
          </button>
        ))}
      </div>

      {items && all.length === 0 && (
        <div className="inbox-empty">
          <p>Nothing here yet.</p>
          <p className="muted small">
            Turn on a source plugin (Gmail, Slack) and Hive will hand each new message to Claude, which decides what is worth an alert. Tell it
            what matters to you in Settings, Assistant.
          </p>
          <button onClick={onOpenPlugins}>Set up a source</button>
        </div>
      )}
      {all.length > 0 && shown.length === 0 && (
        <div className="inbox-empty muted">
          Nothing important. {all.length} item{all.length === 1 ? '' : 's'} checked.{' '}
          <button className="link" onClick={() => setFilter('all')}>
            Show all
          </button>
        </div>
      )}

      <div className="inbox">
        {shown.map((i) => (
          <InboxRow key={i.key} item={i} isNew={fresh.current.has(i.key) && isAlert(i)} />
        ))}
      </div>
    </Modal>
  )
}

function InboxRow({ item: i, isNew }: { item: AssistantItem; isNew: boolean }) {
  const sender = i.fromName || i.from
  const note = i.summary || i.reason
  return (
    <div className={`inbox-row ${isNew ? 'new' : ''}`}>
      <div className="inbox-head">
        <span className={`pill v-${i.verdict}`}>{VERDICT_LABEL[i.verdict]}</span>
        <strong className="inbox-sender" title={i.fromName ? `${i.fromName} <${i.from}>` : i.from}>
          {sender}
        </strong>
        <span className="muted small inbox-where">
          {i.sourceLabel}
          {i.where ? ` · ${i.where}` : ''}
        </span>
        <span className="muted small inbox-time" title={new Date(i.receivedAt).toLocaleString()}>
          {ago(i.receivedAt)}
        </span>
      </div>
      {i.subject && <div className="inbox-subject">{i.subject}</div>}
      {note && <div className={`small inbox-note ${i.verdict === 'error' ? 'error' : 'muted'}`}>{note}</div>}
      <div className="inbox-actions">
        {i.url && (
          <button className="link" onClick={() => void window.hive.app.openExternal(i.url!)}>
            Open
          </button>
        )}
        {i.verdict !== 'muted' && (
          <button className="link muted" onClick={() => void window.hive.assistant.muteSender(i.from)} title={`Never alert me about ${i.from}`}>
            Mute sender
          </button>
        )}
      </div>
    </div>
  )
}
