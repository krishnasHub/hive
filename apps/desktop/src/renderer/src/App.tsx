import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HiveSettings, Presence, PresenceMode, SessionInfo } from '@shared/types'
import { TerminalView, focusTerminalSoon } from './components/TerminalView'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { ApprovalBar } from './components/ApprovalBar'
import { SettingsDialog } from './components/SettingsDialog'
import { SearchDialog } from './components/SearchDialog'
import { NewSessionDialog } from './components/NewSessionDialog'
import { ActivityDialog } from './components/ActivityDialog'
import { wireTerminalData } from './terminals'
import { attentionMap, newlyNeedingAttention, type AttentionKind } from '@core/attention'
import { playChime } from './chime'
import { badgeDataUrl } from './badge'

wireTerminalData()

type Dialog = 'settings' | 'search' | 'new' | 'activity' | null

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

  const createSession = useCallback(async (cwd?: string, title?: string, resumeClaudeSessionId?: string) => {
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
    if (k === 't') return () => setDialog('new')
    if (k === 'w') return () => activeId && void closeSession(activeId)
    if (k === 'f') return () => setDialog('search')
    if (k === ',' || k === '<') return () => setDialog('settings')
    if (/^[1-9]$/.test(e.key)) return () => {
      const s = sessions[Number(e.key) - 1]
      if (s) setActiveId(s.id)
      focusTerminalSoon()
    }
    return null
  }, [cycle, activeId, closeSession, sessions])

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

  if (!settings) return <div className="boot">🐝</div>

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        needsYou={needsYou}
        presence={presence}
        onSelect={(id) => {
          setActiveId(id)
          focusTerminalSoon()
        }}
        onNew={() => setDialog('new')}
        onSearch={() => setDialog('search')}
        onSettings={() => setDialog('settings')}
        onActivity={() => setDialog('activity')}
        onPresence={(mode) => void window.hive.presence.setMode(mode)}
      />
      <main className="main">
        <TabBar
          sessions={sessions}
          activeId={activeId}
          needsYou={needsYou}
          onSelect={(id) => {
            setActiveId(id)
            focusTerminalSoon()
          }}
          onClose={(id) => void closeSession(id)}
          onNew={() => setDialog('new')}
          onRename={(id, title) => void window.hive.sessions.rename(id, title)}
        />
        {active?.pending?.held && <ApprovalBar session={active} />}
        <div className="terminals">
          {sessions.map((s) =>
            s.status === 'dormant' ? null : (
              <TerminalView key={s.id} sessionId={s.id} active={s.id === activeId} general={settings.general} isAppShortcut={isAppShortcut} />
            )
          )}
          {active?.status === 'exited' && (
            <div className="overlay-card">
              <div>
                {errors[active.id] ?? `Claude exited${active.exitCode !== undefined ? ` (code ${active.exitCode})` : ''}.`}
              </div>
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
              <div className="empty-logo">🐝</div>
              <h1>Welcome to Hive</h1>
              <p>Run several Claude Code sessions side by side. Hive tells you when one needs you, on your desktop or your phone.</p>
              <div className="row">
                <button className="primary" onClick={() => setDialog('new')}>
                  New session
                </button>
                <button onClick={() => setDialog('settings')}>Set up phone notifications</button>
              </div>
              <p className="hint">
                {isMac ? '⌘T' : 'Ctrl+Shift+T'} new session · {isMac ? '⌘F' : 'Ctrl+Shift+F'} search history · Ctrl+Tab switch tabs
              </p>
            </div>
          )}
        </div>
      </main>

      {dialog === 'new' && (
        <NewSessionDialog
          sessions={sessions}
          defaultCwd={settings.general.defaultCwd}
          onCreate={(cwd, title) => void createSession(cwd, title)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'search' && (
        <SearchDialog onResume={(hit) => void createSession(hit.cwd || undefined, hit.title || undefined, hit.sessionId)} onClose={() => setDialog(null)} />
      )}
      {dialog === 'settings' && <SettingsDialog settings={settings} onChange={setSettings} onClose={() => setDialog(null)} />}
      {dialog === 'activity' && <ActivityDialog onClose={() => setDialog(null)} />}
    </div>
  )
}
