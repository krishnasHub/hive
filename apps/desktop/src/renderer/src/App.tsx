import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AssistantItem, HiveSettings, Presence, PresenceMode, SessionInfo } from '@shared/types'
import { attentionMap, newlyNeedingAttention, type AttentionKind } from '@core/attention'
import { TerminalView, focusTerminalSoon } from './components/TerminalView'
import { TitleBar } from './components/TitleBar'
import { ApprovalBar, TrustBar } from './components/ApprovalBar'
import { SettingsDialog, type SettingsTab } from './components/SettingsDialog'
import { SearchDialog } from './components/SearchDialog'
import { NewSessionDialog } from './components/NewSessionDialog'
import { ActivityDialog } from './components/ActivityDialog'
import { InboxDialog, isAlert } from './components/InboxDialog'
import { wireTerminalData } from './terminals'
import { playChime } from './chime'
import { badgeDataUrl } from './badge'
import { loadRecent, saveRecent } from './recent'

wireTerminalData()

type Dialog = { kind: 'settings'; tab: SettingsTab } | { kind: 'search' } | { kind: 'new' } | { kind: 'activity' } | { kind: 'inbox' } | null

const isMac = window.hive.platform === 'darwin'

export function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [settings, setSettings] = useState<HiveSettings | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [presence, setPresence] = useState<{ presence: Presence; mode: PresenceMode }>({ presence: 'present', mode: 'auto' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [seen, setSeen] = useState<Record<string, number>>({})
  const [focused, setFocused] = useState(() => document.hasFocus())

  useEffect(() => {
    const on = () => setFocused(true)
    const off = () => setFocused(false)
    window.addEventListener('focus', on)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('focus', on)
      window.removeEventListener('blur', off)
    }
  }, [])

  useEffect(() => {
    void window.hive.sessions.list().then((list) => {
      setSessions(list)
      setActiveId((cur) => cur ?? list[0]?.id ?? null)
    })
    void window.hive.settings.get().then(setSettings)
    void window.hive.presence.get().then(setPresence)
    const offs = [
      window.hive.sessions.onUpdate((s) =>
        setSessions((prev) => {
          const i = prev.findIndex((x) => x.id === s.id)
          if (i < 0) return [...prev, s]
          const next = prev.slice()
          next[i] = s
          return next
        })
      ),
      window.hive.sessions.onRemoved((id) => setSessions((prev) => prev.filter((s) => s.id !== id))),
      window.hive.sessions.onError((id, message) => setErrors((e) => ({ ...e, [id]: message }))),
      window.hive.sessions.onFocus((id) => setActiveId(id)),
      window.hive.presence.onChange(setPresence)
    ]
    return () => offs.forEach((off) => off())
  }, [])

  // Assistant Inbox: badge for unseen important items, and a chime when a new one arrives (not for what was there at startup).
  const [inboxCount, setInboxCount] = useState(0)
  const soundRef = useRef<{ on: boolean; volume: number }>({ on: false, volume: 0.6 })
  soundRef.current = { on: !!settings?.notifications.sound, volume: settings?.notifications.soundVolume ?? 0.6 }
  useEffect(() => {
    let known: Set<string> | null = null
    let alive = true
    const load = () =>
      void window.hive.assistant.list().then((items: AssistantItem[]) => {
        if (!alive) return
        const alerts = items.filter(isAlert)
        setInboxCount(alerts.filter((i) => !i.seen).length)
        const arrived = known !== null && alerts.some((i) => !i.seen && !known!.has(i.key))
        known = new Set(alerts.map((i) => i.key))
        if (arrived && soundRef.current.on) playChime('needs_you', soundRef.current.volume)
      })
    load()
    const off = window.hive.assistant.onChange(load)
    // Clicking an alert's desktop notification opens the Inbox.
    const offOpen = window.hive.assistant.onOpenInbox(() => setDialog({ kind: 'inbox' }))
    return () => {
      alive = false
      off()
      offOpen()
    }
  }, [])

  // Keep a valid active tab.
  useEffect(() => {
    if (activeId && sessions.some((s) => s.id === activeId)) return
    setActiveId(sessions[0]?.id ?? null)
  }, [sessions, activeId])

  // You've seen the active tab once the window has focus (clears its badge).
  const active = sessions.find((s) => s.id === activeId)
  useEffect(() => {
    if (active && focused) setSeen((m) => ({ ...m, [active.id]: active.lastActivityAt }))
  }, [active?.id, active?.lastActivityAt, focused])

  // Dormant tabs (restored from last time) start when you open them.
  useEffect(() => {
    if (active?.status === 'dormant') void window.hive.sessions.start(active.id)
  }, [active?.id, active?.status])

  const [recentTick, setRecentTick] = useState(0)
  const recentFolders = useMemo(() => {
    const all = [...loadRecent(), ...sessions.map((s) => s.cwd), settings?.general.defaultCwd ?? '']
    return [...new Set(all.filter(Boolean))]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.length, settings?.general.defaultCwd, recentTick])

  const createSession = useCallback(async (cwd?: string, title?: string, resumeClaudeSessionId?: string) => {
    if (cwd) {
      saveRecent(cwd)
      setRecentTick((t) => t + 1)
    }
    const s = await window.hive.sessions.create({ cwd, title, resumeClaudeSessionId })
    setSessions((prev) => (prev.some((x) => x.id === s.id) ? prev : [...prev, s]))
    setActiveId(s.id)
    setDialog(null)
    focusTerminalSoon()
  }, [])

  const closeSession = useCallback(async (id: string) => {
    const s = sessions.find((x) => x.id === id)
    if (s && (s.status === 'working' || s.status === 'waiting_permission')) {
      if (!confirm(`"${s.title}" is still running. Close it? (You can resume it later from Search.)`)) return
    }
    await window.hive.sessions.close(id)
  }, [sessions])

  // "+" opens a new tab in the current tab's folder, like duplicating a terminal tab.
  const quickCwd = () => active?.cwd || recentFolders[0] || settings?.general.defaultCwd

  const cycle = useCallback(
    (dir: 1 | -1) => {
      if (!sessions.length) return
      const i = sessions.findIndex((s) => s.id === activeId)
      setActiveId(sessions[(i + dir + sessions.length) % sessions.length].id)
      focusTerminalSoon()
    },
    [sessions, activeId]
  )

  // App shortcuts. Kept off plain Ctrl+<letter> so Claude Code's own keys keep working.
  const shortcut = useCallback((e: KeyboardEvent): (() => void) | null => {
    const mod = isMac ? e.metaKey : e.ctrlKey && e.shiftKey
    const k = e.key.toLowerCase()
    if (e.ctrlKey && e.key === 'Tab') return () => cycle(e.shiftKey ? -1 : 1)
    if (!mod) return null
    if (k === 't') return () => void createSession(quickCwd())
    if (k === 'n') return () => setDialog({ kind: 'new' })
    if (k === 'w') return () => activeId && void closeSession(activeId)
    if (k === 'f') return () => setDialog({ kind: 'search' })
    if (k === 'i') return () => setDialog({ kind: 'inbox' })
    if (k === ',' || k === '<') return () => setDialog({ kind: 'settings', tab: 'general' })
    if (/^[1-9]$/.test(e.key)) return () => {
      const s = sessions[Number(e.key) - 1]
      if (s) setActiveId(s.id)
      focusTerminalSoon()
    }
    return null
  }, [cycle, activeId, closeSession, sessions, createSession])

  const shortcutRef = useRef(shortcut)
  shortcutRef.current = shortcut
  const isAppShortcut = useCallback((e: KeyboardEvent) => shortcutRef.current(e) !== null, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const run = shortcutRef.current(e)
      if (!run) return
      e.preventDefault()
      e.stopPropagation()
      run()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const attention = useMemo(() => attentionMap(sessions, activeId, focused, seen), [sessions, activeId, focused, seen])
  const needsYou = useMemo(() => new Set(attention.keys()), [attention])

  // Chime when something new needs you; skip whatever was already pending when the app opened.
  const prevAttention = useRef<Map<string, AttentionKind> | null>(null)
  const loaded = settings !== null && sessions.length > 0
  useEffect(() => {
    if (!loaded) return
    const prev = prevAttention.current
    prevAttention.current = attention
    if (!prev || !settings?.notifications.sound) return
    const kind = newlyNeedingAttention(prev, attention)
    if (kind) playChime(kind, settings.notifications.soundVolume)
  }, [attention, loaded, settings?.notifications.sound, settings?.notifications.soundVolume])

  // Taskbar badge: how many sessions need you.
  useEffect(() => {
    const n = attention.size
    window.hive.app.setBadge(n, n ? badgeDataUrl(n) : null)
  }, [attention.size])

  if (!settings) return <div className="boot" />

  const select = (id: string) => {
    setActiveId(id)
    focusTerminalSoon()
  }

  return (
    <div className="app">
      <TitleBar
        platform={window.hive.platform}
        sessions={sessions}
        activeId={activeId}
        needsYou={needsYou}
        recentFolders={recentFolders}
        presence={presence}
        onSelect={select}
        onClose={(id) => void closeSession(id)}
        onRename={(id, title) => void window.hive.sessions.rename(id, title)}
        onNewQuick={() => void createSession(quickCwd())}
        onNewIn={(cwd) => void createSession(cwd)}
        onNewChoose={() => setDialog({ kind: 'new' })}
        inboxCount={inboxCount}
        onInbox={() => setDialog({ kind: 'inbox' })}
        onSearch={() => setDialog({ kind: 'search' })}
        onActivity={() => setDialog({ kind: 'activity' })}
        onPlugins={() => setDialog({ kind: 'settings', tab: 'plugins' })}
        onSettings={() => setDialog({ kind: 'settings', tab: 'general' })}
        onPresence={(mode) => void window.hive.presence.setMode(mode)}
      />
      {active?.trustPrompt && <TrustBar session={active} />}
      {active?.pending?.held && <ApprovalBar session={active} />}
      <main className="terminals">
        {sessions.map((s) =>
          s.status === 'dormant' ? null : (
            <TerminalView key={s.id} sessionId={s.id} active={s.id === activeId} general={settings.general} isAppShortcut={isAppShortcut} />
          )
        )}
        {active?.status === 'exited' && (
          <div className="overlay-card">
            <div>{errors[active.id] || `Claude exited${active.exitCode !== undefined ? ` (code ${active.exitCode})` : ''}.`}</div>
            <div className="row">
              <button
                className="primary"
                onClick={() => {
                  setErrors((e) => ({ ...e, [active.id]: '' }))
                  void window.hive.sessions.start(active.id)
                }}
              >
                Resume conversation
              </button>
              <button onClick={() => void closeSession(active.id)}>Close tab</button>
            </div>
          </div>
        )}
        {!sessions.length && (
          <div className="empty">
            <pre className="empty-prompt">
              <span className="accent">hive</span> <span className="muted">~</span> {'>'} <span className="cursor" />
            </pre>
            <p>
              Press <kbd>+</kbd> or <kbd>{isMac ? '⌘T' : 'Ctrl+Shift+T'}</kbd> to start a Claude session.
            </p>
            <p className="muted small">
              <button className="link" onClick={() => setDialog({ kind: 'settings', tab: 'plugins' })}>
                Set up phone notifications
              </button>{' '}
              · <kbd>{isMac ? '⌘F' : 'Ctrl+Shift+F'}</kbd> search past sessions · <kbd>Ctrl+Tab</kbd> switch tabs
            </p>
          </div>
        )}
      </main>

      {dialog?.kind === 'new' && (
        <NewSessionDialog recent={recentFolders} defaultCwd={quickCwd() ?? ''} onCreate={(cwd, title) => void createSession(cwd, title)} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'search' && (
        <SearchDialog onResume={(hit) => void createSession(hit.cwd || undefined, hit.title || undefined, hit.sessionId)} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'settings' && <SettingsDialog initialTab={dialog.tab} settings={settings} onChange={setSettings} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'activity' && <ActivityDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'inbox' && (
        <InboxDialog onClose={() => setDialog(null)} onOpenPlugins={() => setDialog({ kind: 'settings', tab: 'plugins' })} />
      )}
    </div>
  )
}
