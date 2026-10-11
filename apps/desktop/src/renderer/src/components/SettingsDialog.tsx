import { useEffect, useState } from 'react'
import type { AssistantSettings, HiveSettings, LidMode, NotificationSettings, PluginInfo, PluginSettingField, PowerStatus } from '@shared/types'
import { Modal } from './Modal'
import { playChime } from '../chime'
import { statsLine, useAssistantStats } from './InboxDialog'

export type SettingsTab = 'plugins' | 'assistant' | 'notifications' | 'general'

const TAB_LABELS: Record<SettingsTab, string> = {
  general: 'General',
  notifications: 'Notifications',
  assistant: 'Assistant',
  plugins: 'Plugins'
}

interface Props {
  initialTab?: SettingsTab
  settings: HiveSettings
  onChange(s: HiveSettings): void
  onClose(): void
}

export function SettingsDialog({ initialTab = 'general', settings, onChange, onClose }: Props) {
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const save = async (patch: Partial<HiveSettings>) => onChange(await window.hive.settings.update(patch))

  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="tabs">
        {(['general', 'notifications', 'assistant', 'plugins'] as SettingsTab[]).map((t) => (
          <button key={t} className={tab === t ? 'selected' : ''} onClick={() => setTab(t)}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      {tab === 'plugins' && <Plugins />}
      {tab === 'notifications' && <Notifications value={settings.notifications} onSave={(n) => save({ notifications: n })} />}
      {tab === 'assistant' && <Assistant settings={settings} onSave={(a) => save({ assistant: a })} onPlugins={() => setTab('plugins')} />}
      {tab === 'general' && <General settings={settings} onSave={save} />}
    </Modal>
  )
}

// ---------------- plugins: phone channels and sources ----------------

function usePlugins() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  useEffect(() => {
    const load = () => void window.hive.plugins.list().then(setPlugins)
    load()
    return window.hive.plugins.onChange(load)
  }, [])
  return plugins
}

const isChannel = (p: PluginInfo) => !!p.manifest.contributes?.channel
const isSource = (p: PluginInfo) => !!p.manifest.contributes?.source

function Plugins() {
  const plugins = usePlugins()
  const [open, setOpen] = useState<string | null>(null)
  const channels = plugins.filter(isChannel)
  const sources = plugins.filter((p) => isSource(p) && !isChannel(p))
  const card = (p: PluginInfo) => (
    <PluginCard key={p.manifest.id} plugin={p} open={open === p.manifest.id} onToggleOpen={() => setOpen(open === p.manifest.id ? null : p.manifest.id)} />
  )
  return (
    <div>
      <p className="muted">
        <strong className="text">Phone channels.</strong> Turn on one or more ways for Hive to reach you. When a session needs you and you're
        away, Hive messages you there, and you can reply in the thread to answer.
      </p>
      <p className="muted small">
        To add a plugin, drop its folder into{' '}
        <button className="link" onClick={() => void window.hive.plugins.openFolder()}>
          ~/.hive/plugins
        </button>{' '}
        and restart Hive. Writing your own takes about 50 lines; see docs/PLUGINS.md in the Hive repo.
      </p>
      {channels.map(card)}
      {channels.length === 0 && <div className="muted">No channel plugins found.</div>}

      <h3 className="section-title">Sources</h3>
      <p className="muted">
        Sources watch places like Gmail and Slack and hand new messages to the assistant. Claude reads them and alerts you only about the
        ones that matter. Set what matters in the Assistant tab.
      </p>
      {sources.map(card)}
      {sources.length === 0 && <div className="muted">No source plugins found.</div>}
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
            {isChannel(plugin) && isSource(plugin) && <span className="tag">also a source</span>}
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
              {isChannel(plugin) ? 'Send test message' : 'Test connection'}
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

// ---------------- assistant (sources -> triage -> alerts) ----------------

const DEFAULT_ASSISTANT: AssistantSettings = { interests: '', vipSenders: [], mutedSenders: [], model: 'haiku', paused: false }
const MODELS = [
  { value: 'haiku', label: 'Haiku (fast, cheapest)' },
  { value: 'sonnet', label: 'Sonnet (more careful)' }
]

const lines = (text: string) => [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))]

function Assistant({ settings, onSave, onPlugins }: { settings: HiveSettings; onSave(a: AssistantSettings): void; onPlugins(): void }) {
  const init = { ...DEFAULT_ASSISTANT, ...settings.assistant }
  const [a, setA] = useState(init)
  const [vip, setVip] = useState(init.vipSenders.join('\n'))
  const [muted, setMuted] = useState(init.mutedSenders.join('\n'))
  const stats = useAssistantStats()
  const sources = usePlugins().filter(isSource)

  // "Mute sender" in the Inbox changes mutedSenders behind our back; start from the stored list so Save doesn't undo it.
  useEffect(() => {
    void window.hive.settings.get().then((s) => {
      const fresh = { ...DEFAULT_ASSISTANT, ...s.assistant }
      setA(fresh)
      setVip(fresh.vipSenders.join('\n'))
      setMuted(fresh.mutedSenders.join('\n'))
    })
  }, [])

  const models = MODELS.some((m) => m.value === a.model) ? MODELS : [...MODELS, { value: a.model, label: a.model }]

  return (
    <div>
      <p className="muted">
        <strong className="text">Assistant.</strong> Source plugins watch Gmail and Slack. Claude (Haiku, no tools, reads only) decides which new
        messages are worth an alert. Hive shows those as a desktop notification and sends them to your phone channels, using the rules in
        Notifications.
      </p>
      <label className="field">
        <span>What matters to me</span>
        <textarea
          rows={4}
          value={a.interests}
          placeholder="e.g. messages from my manager, production incidents, anything about invoices or contracts, travel changes"
          onChange={(e) => setA({ ...a, interests: e.target.value })}
        />
        <small className="muted">Plain language. Claude reads this when it decides whether to alert you.</small>
      </label>
      <div className="grid2">
        <label className="field">
          <span>Always alert me about</span>
          <textarea rows={4} value={vip} placeholder={'boss@company.com\n@bigclient.com\nJane Doe'} onChange={(e) => setVip(e.target.value)} spellCheck={false} />
          <small className="muted">One sender per line: email address, @domain, or name. Skips Claude.</small>
        </label>
        <label className="field">
          <span>Never alert me about</span>
          <textarea rows={4} value={muted} placeholder={'newsletter@shop.com\n@notifications.github.com'} onChange={(e) => setMuted(e.target.value)} spellCheck={false} />
          <small className="muted">One sender per line. They still show in the Inbox.</small>
        </label>
      </div>
      <div className="grid2">
        <label className="field">
          <span>Model</span>
          <select value={a.model} onChange={(e) => setA({ ...a, model: e.target.value })}>
            {models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span>&nbsp;</span>
          <label className="field inline">
            <input type="checkbox" checked={a.paused} onChange={(e) => setA({ ...a, paused: e.target.checked })} />
            Pause alerts (sources keep collecting, nothing is checked or sent)
          </label>
        </div>
      </div>
      <div className="muted small">
        {statsLine(stats)}
        {stats?.lastError && <div className="error">{stats.lastError}</div>}
      </div>
      <div className="row end">
        <button className="primary" onClick={() => onSave({ ...a, vipSenders: lines(vip), mutedSenders: lines(muted) })}>
          Save
        </button>
      </div>

      <h3 className="section-title">Sources</h3>
      {sources.length === 0 && <div className="muted small">No source plugins installed yet.</div>}
      {sources.map((p) => {
        const state = p.enabled ? p.runState : 'disabled'
        return (
          <div key={p.manifest.id} className="source-row">
            <span>{p.manifest.contributes?.source?.label ?? p.manifest.name}</span>
            <span className={`small source-msg ${state === 'error' ? 'error' : 'muted'}`}>{p.statusMessage}</span>
            <span className={`pill ${state}`}>{state}</span>
          </div>
        )
      })}
      <div className="row end">
        <button onClick={onPlugins}>Set up sources in Plugins</button>
      </div>
    </div>
  )
}

// ---------------- general ----------------

function powerLine(st: PowerStatus, keepAwake: boolean): string {
  const n = st.activeSessions
  const awake = st.blocking
    ? `Keeping awake: ${n} session${n === 1 ? '' : 's'} working`
    : keepAwake
      ? 'Not keeping awake right now: no sessions working'
      : 'Sleeping as usual'
  const lid = !st.lid.supported
    ? (st.lid.message ?? 'Lid setting is not supported on this computer')
    : st.lid.engaged
      ? `Lid closed: keeps running${st.lid.message ? ` (${st.lid.message})` : ''}`
      : st.lid.message
  return lid ? `${awake} · ${lid}` : awake
}

function General({ settings, onSave }: { settings: HiveSettings; onSave(p: Partial<HiveSettings>): void }) {
  const [g, setG] = useState(settings.general)
  const [detected, setDetected] = useState<string | null>(null)
  const [power, setPower] = useState<PowerStatus | null>(null)
  useEffect(() => void window.hive.settings.detectClaude().then(setDetected), [])
  useEffect(() => {
    void window.hive.power.status().then(setPower)
    return window.hive.power.onStatus(setPower)
  }, [])
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
      <label className="field inline">
        <input type="checkbox" checked={g.autoTrustFolders} onChange={(e) => setG({ ...g, autoTrustFolders: e.target.checked })} />
        Trust folders automatically when I start a session in them (skips Claude's "Do you trust this folder?" question)
      </label>
      <label className="field inline">
        <input type="checkbox" checked={g.closeToTray} onChange={(e) => setG({ ...g, closeToTray: e.target.checked })} />
        Keep running in the system tray when I close the window (sessions and notifications continue)
      </label>
      <label className="field inline">
        <input type="checkbox" checked={g.launchAtLogin} onChange={(e) => setG({ ...g, launchAtLogin: e.target.checked })} />
        Start Hive when I log in (in the tray)
      </label>
      <div className="field">
        <span>Power</span>
        <label className="field inline">
          <input type="checkbox" checked={g.keepAwake} onChange={(e) => setG({ ...g, keepAwake: e.target.checked })} />
          Keep this computer awake while Claude is working
        </label>
        <label className="field">
          <span className="muted">When the lid is closed</span>
          <select value={g.lidClosed} disabled={!g.keepAwake} onChange={(e) => setG({ ...g, lidClosed: e.target.value as LidMode })}>
            <option value="off">Sleep as usual</option>
            <option value="plugged-in">Keep running when plugged in</option>
            <option value="always">Keep running, also on battery</option>
          </select>
          <small className="muted">
            Only while sessions are working; Hive puts your lid setting back afterwards. A laptop left running in a bag can get hot.
          </small>
        </label>
        {power && <small className={power.blocking ? 'text' : 'muted'}>{powerLine(power, settings.general.keepAwake)}</small>}
      </div>
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
