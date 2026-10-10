// Windows Terminal–style title bar: tabs on the left, a new-tab button with a folder menu, tools on the right.
import { useState } from 'react'
import type { Presence, PresenceMode, SessionInfo } from '@shared/types'
import { ActivityIcon, ChevronDownIcon, CloseIcon, FolderIcon, GearIcon, PersonIcon, PlusIcon, PluginIcon, SearchIcon } from './Icons'
import { Menu, type MenuItem } from './Menu'
import { StatusDot, statusLabel } from './StatusDot'
import { basename } from '../recent'

interface Props {
  platform: string
  sessions: SessionInfo[]
  activeId: string | null
  needsYou: Set<string>
  recentFolders: string[]
  presence: { presence: Presence; mode: PresenceMode }
  onSelect(id: string): void
  onClose(id: string): void
  onRename(id: string, title: string): void
  onNewQuick(): void
  onNewIn(cwd: string): void
  onNewChoose(): void
  onSearch(): void
  onActivity(): void
  onPlugins(): void
  onSettings(): void
  onPresence(mode: PresenceMode): void
}

export function TitleBar(p: Props) {
  const [editing, setEditing] = useState<string | null>(null)
  const [menu, setMenu] = useState<'new' | 'presence' | null>(null)
  const mod = p.platform === 'darwin' ? '⌘' : 'Ctrl+Shift+'

  const newItems: (MenuItem | 'separator')[] = [
    ...p.recentFolders.slice(0, 8).map((d) => ({
      label: (
        <>
          <FolderIcon /> {basename(d)} <span className="muted">{d}</span>
        </>
      ),
      onSelect: () => p.onNewIn(d)
    })),
    ...(p.recentFolders.length ? (['separator'] as const) : []),
    { label: 'Choose folder…', hint: `${mod}T`, onSelect: p.onNewChoose }
  ]

  const presenceItems: MenuItem[] = [
    { label: 'Detect when I’m away', checked: p.presence.mode === 'auto', onSelect: () => p.onPresence('auto') },
    { label: 'I’m at my desk', checked: p.presence.mode === 'present', onSelect: () => p.onPresence('present') },
    { label: 'I’m away: send to my phone', checked: p.presence.mode === 'away', onSelect: () => p.onPresence('away') }
  ]

  const away = p.presence.presence === 'away'

  return (
    <header className={`titlebar platform-${p.platform}`}>
      <div className="tabs-strip" role="tablist">
        {p.sessions.map((s) => (
          <div
            key={s.id}
            role="tab"
            aria-selected={s.id === p.activeId}
            className={`tab ${s.id === p.activeId ? 'active' : ''}`}
            onMouseDown={(e) => e.button === 0 && p.onSelect(s.id)}
            onDoubleClick={() => setEditing(s.id)}
            onAuxClick={(e) => e.button === 1 && p.onClose(s.id)}
            title={`${s.title}\n${s.cwd}\n${statusLabel(s)} · reply code ${s.shortCode}\nDouble-click to rename`}
          >
            <StatusDot session={s} attention={p.needsYou.has(s.id)} />
            {editing === s.id ? (
              <input
                autoFocus
                defaultValue={s.title}
                onMouseDown={(e) => e.stopPropagation()}
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
            <button
              className="tab-close"
              aria-label={`Close ${s.title}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => p.onClose(s.id)}
            >
              <CloseIcon />
            </button>
          </div>
        ))}
        <div className="new-tab">
          <button className="tb-btn" onClick={p.onNewQuick} title={`New session (${mod}T)`} aria-label="New session">
            <PlusIcon />
          </button>
          <button className="tb-btn narrow" onClick={() => setMenu(menu === 'new' ? null : 'new')} title="New session in…" aria-label="New session in folder">
            <ChevronDownIcon />
          </button>
          {menu === 'new' && <Menu items={newItems} onClose={() => setMenu(null)} />}
        </div>
      </div>

      <div className="drag-space" />

      <div className="tools">
        <div className="tool-wrap">
          <button
            className={`tb-btn ${away ? 'away' : ''}`}
            onClick={() => setMenu(menu === 'presence' ? null : 'presence')}
            title={away ? 'Away: notifications go to your phone' : 'At your desk: notifications stay on this computer'}
            aria-label="Presence"
          >
            <PersonIcon away={away} />
          </button>
          {menu === 'presence' && <Menu items={presenceItems} onClose={() => setMenu(null)} align="right" />}
        </div>
        <button className="tb-btn" onClick={p.onSearch} title={`Search past sessions (${mod}F)`} aria-label="Search">
          <SearchIcon />
        </button>
        <button className="tb-btn" onClick={p.onActivity} title="Activity log" aria-label="Activity">
          <ActivityIcon />
        </button>
        <button className="tb-btn" onClick={p.onPlugins} title="Plugins and phone channels" aria-label="Plugins">
          <PluginIcon />
        </button>
        <button className="tb-btn" onClick={p.onSettings} title={`Settings (${mod},)`} aria-label="Settings">
          <GearIcon />
        </button>
      </div>
    </header>
  )
}
