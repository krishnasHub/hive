import { useEffect, useState } from 'react'
import type { HiveSettings, NotificationSettings, PluginInfo, PluginSettingField } from '@shared/types'
import { Modal } from './Modal'
import { playChime } from '../chime'

type Tab = 'notifications' | 'channels' | 'general'

interface Props {
  settings: HiveSettings
  onChange(s: HiveSettings): void
  onClose(): void
}

export function SettingsDialog({ settings, onChange, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('channels')
  const save = async (patch: Partial<HiveSettings>) => onChange(await window.hive.settings.update(patch))

  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="tabs">
        {(['channels', 'notifications', 'general'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'selected' : ''} onClick={() => setTab(t)}>
            {t === 'channels' ? 'Phone channels' : t === 'notifications' ? 'When to notify' : 'General'}
          </button>
        ))}
      </div>
      {tab === 'channels' && <Channels />}
      {tab === 'notifications' && <Notifications value={settings.notifications} onSave={(n) => save({ notifications: n })} />}
      {tab === 'general' && <General settings={settings} onSave={save} />}
    </Modal>
  )
}

// ---------------- channels (notification plugins) ----------------

function Channels() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    const load = () => void window.hive.plugins.list().then(setPlugins)
    load()
    return window.hive.plugins.onChange(load)
  }, [])
  const channels = plugins.filter((p) => p.manifest.contributes?.channel)
  return (
    <div>
      <p className="muted">
        Pick one or more ways to reach you. When a session needs you and you're away, Hive messages you there. Reply in the thread to answer.
        Channels are plugins. Add your own in{' '}
        <button className="link" onClick={() => void window.hive.plugins.openFolder()}>
          ~/.hive/plugins
        </button>
        .
      </p>
      {channels.map((p) => (
        <PluginCard key={p.manifest.id} plugin={p} open={open === p.manifest.id} onToggleOpen={() => setOpen(open === p.manifest.id ? null : p.manifest.id)} />
      ))}
      {channels.length === 0 && <div className="muted">No channel plugins found.</div>}
    </div>
  )
}

function PluginCard({ plugin, open, onToggleOpen }: { plugin: PluginInfo; open: boolean; onToggleOpen(): void }) {
  const m = plugin.manifest
  const [values, setValues] = useState<Record<string, unknown>>(plugin.settings)
  const [testMsg, setTestMsg] = useState<{ ok: boolean; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => setValues(plugin.settings), [plugin.settings])

  const dirty = (m.settings ?? []).some((f) => values[f.key] !== plugin.settings[f.key])
  const state = plugin.enabled ? plugin.runState : 'disabled'

  return (
    <div className={`plugin-card ${open ? 'open' : ''}`}>
      <div className="plugin-head" onClick={onToggleOpen}>
        <div>
          <div className="plugin-name">
            {m.name} {!plugin.builtin && <span className="tag">custom</span>}
          </div>
          <div className="muted small">{m.description}</div>
        </div>
        <div className="row" onClick={(e) => e.stopPropagation()}>
          <span className={`pill ${state}`}>{state}</span>
          <label className="switch" title={plugin.enabled ? 'Disable' : 'Enable'}>
            <input type="checkbox" checked={plugin.enabled} onChange={(e) => void window.hive.plugins.setEnabled(m.id, e.target.checked)} />
            <span />
          </label>
        </div>
      </div>
      {plugin.statusMessage && <div className={`plugin-status ${state === 'error' ? 'error' : ''}`}>{plugin.statusMessage}</div>}
      {open && (
        <div className="plugin-body">
          {m.docs && <pre className="docs">{m.docs}</pre>}
          {(m.settings ?? []).map((f) => (
            <SettingField key={f.key} field={f} value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
          ))}
          <div className="row end">
            {testMsg && <span className={`small ${testMsg.ok ? 'ok' : 'error'}`}>{testMsg.message}</span>}
            <button
              disabled={busy || !plugin.enabled}
              onClick={async () => {
                setBusy(true)
                setTestMsg(null)
                setTestMsg(await window.hive.plugins.test(m.id))
                setBusy(false)
              }}
            >
              Send test message
            </button>
            <button className="primary" disabled={!dirty} onClick={() => void window.hive.plugins.configure(m.id, values)}>
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function SettingField({ field, value, onChange }: { field: PluginSettingField; value: unknown; onChange(v: unknown): void }) {
  const label = (
    <span>
      {field.label}
      {field.required && <span className="req"> *</span>}
    </span>
  )
  let input
  switch (field.type) {
    case 'boolean':
      return (
        <label className="field inline">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          {label}
          {field.help && <small className="muted">{field.help}</small>}
        </label>
      )
    case 'select':
      input = (
        <select value={String(value ?? field.default ?? '')} onChange={(e) => onChange(e.target.value)}>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )
      break
    case 'number':
      input = <input type="number" value={String(value ?? '')} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
      break
    case 'text':
      input = <textarea rows={3} value={String(value ?? '')} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
      break
    default:
      input = (
        <input
          type={field.type === 'secret' ? 'password' : 'text'}
          value={String(value ?? '')}
          placeholder={field.placeholder}
          onFocus={(e) => field.type === 'secret' && e.target.value === '••••••••' && onChange('')}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      )
  }
  return (
    <label className="field">
      {label}
      {input}
      {field.help && <small className="muted">{field.help}</small>}
    </label>
  )
}

// ---------------- when to notify ----------------

function Notifications({ value, onSave }: { value: NotificationSettings; onSave(n: NotificationSettings): void }) {
  const [n, setN] = useState(value)
  const set = <K extends keyof NotificationSettings>(k: K, v: NotificationSettings[K]) => setN((x) => ({ ...x, [k]: v }))
  return (
    <div>
      <div className="field">
        <span>Sound</span>
        <div className="row">
          <label className="field inline">
            <input type="checkbox" checked={n.sound} onChange={(e) => set('sound', e.target.checked)} />
            Chime when a session needs me or finishes in the background
          </label>
        </div>
        <div className="row">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={n.soundVolume}
            disabled={!n.sound}
            onChange={(e) => set('soundVolume', Number(e.target.value))}
            aria-label="Chime volume"
            style={{ maxWidth: 220 }}
          />
          <button onClick={() => playChime('needs_you', n.soundVolume)}>Needs you ▶</button>
          <button onClick={() => playChime('update', n.soundVolume)}>Finished ▶</button>
        </div>
      </div>
      <label className="field">
        <span>Send to my phone channels</span>
        <select value={n.remoteWhen} onChange={(e) => set('remoteWhen', e.target.value as NotificationSettings['remoteWhen'])}>
          <option value="away">Only when I'm away from the computer</option>
          <option value="always">Always</option>
          <option value="never">Never (desktop notifications only)</option>
        </select>
      </label>
      <div className="grid2">
        <label className="field">
          <span>I'm "away" after this many idle seconds</span>
          <input type="number" min={15} value={n.awayAfterSec} onChange={(e) => set('awayAfterSec', Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Wait before sending to phone (seconds)</span>
          <input type="number" min={0} value={n.remoteDelaySec} onChange={(e) => set('remoteDelaySec', Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Only report "finished" for turns longer than (seconds)</span>
          <input type="number" min={0} value={n.finishedMinSec} onChange={(e) => set('finishedMinSec', Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Hold permission prompts for up to (minutes)</span>
          <input type="number" min={1} value={Math.round(n.permissionTimeoutSec / 60)} onChange={(e) => set('permissionTimeoutSec', Number(e.target.value) * 60)} />
        </label>
      </div>
      <div className="field">
        <span>Notify me when Claude…</span>
        {(
          [
            ['permission', 'needs permission to run a tool'],
            ['waiting', 'asks me a question or is waiting for input'],
            ['finished', 'finishes a long task']
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="field inline">
            <input type="checkbox" checked={n.notifyOn[k]} onChange={(e) => set('notifyOn', { ...n.notifyOn, [k]: e.target.checked })} />
            {label}
          </label>
        ))}
      </div>
      <label className="field">
        <span>Answer permission prompts from Hive and my phone</span>
        <select value={n.interceptPermissions} onChange={(e) => set('interceptPermissions', e.target.value as NotificationSettings['interceptPermissions'])}>
          <option value="always">Always (Hive shows Allow/Deny above the terminal)</option>
          <option value="away">Only when I'm away (otherwise Claude's own prompt)</option>
          <option value="never">Never (Claude's own prompt; phone replies type Enter/Esc into it)</option>
        </select>
        <small className="muted">Applies to sessions started after you save.</small>
      </label>
      <div className="row end">
        <button className="primary" onClick={() => onSave(n)}>
          Save
        </button>
      </div>
    </div>
  )
}

// ---------------- general ----------------

function General({ settings, onSave }: { settings: HiveSettings; onSave(p: Partial<HiveSettings>): void }) {
  const [g, setG] = useState(settings.general)
  const [detected, setDetected] = useState<string | null>(null)
  useEffect(() => void window.hive.settings.detectClaude().then(setDetected), [])
  return (
    <div>
      <label className="field">
        <span>Claude Code executable</span>
        <input value={g.claudePath} placeholder={detected ?? 'Not found. Install Claude Code first.'} onChange={(e) => setG({ ...g, claudePath: e.target.value })} />
        <small className="muted">Leave empty to auto-detect{detected ? ` (found ${detected})` : ''}.</small>
      </label>
      <label className="field">
        <span>Extra arguments for claude</span>
        <input value={g.extraArgs} placeholder="e.g. --model opus" onChange={(e) => setG({ ...g, extraArgs: e.target.value })} />
        <small className="muted">Added to every new session.</small>
      </label>
      <label className="field">
        <span>Default project folder</span>
        <div className="row">
          <input value={g.defaultCwd} onChange={(e) => setG({ ...g, defaultCwd: e.target.value })} />
          <button
            onClick={async () => {
              const d = await window.hive.app.pickFolder(g.defaultCwd)
              if (d) setG({ ...g, defaultCwd: d })
            }}
          >
            Browse…
          </button>
        </div>
      </label>
      <div className="grid2">
        <label className="field">
          <span>Font size</span>
          <input type="number" min={9} max={28} value={g.fontSize} onChange={(e) => setG({ ...g, fontSize: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>Font family</span>
          <input value={g.fontFamily} onChange={(e) => setG({ ...g, fontFamily: e.target.value })} />
        </label>
      </div>
      <div className="row end">
        <button className="primary" onClick={() => onSave({ general: g })}>
          Save
        </button>
      </div>
    </div>
  )
}
