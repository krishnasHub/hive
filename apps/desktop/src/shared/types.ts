// Types shared by main, preload and renderer.

export type SessionStatus =
  | 'dormant' // restored tab, process not started yet
  | 'starting'
  | 'idle' // at the prompt, nothing running
  | 'working'
  | 'waiting_permission'
  | 'waiting_input'
  | 'exited'

export interface PendingPermission {
  requestId: string
  toolName: string
  /** One-line human summary, e.g. the Bash command or file path. */
  summary: string
  toolInput: unknown
  createdAt: number
  /** True when Hive is holding the PermissionRequest hook open (can answer directly). */
  held: boolean
}

export interface SessionInfo {
  id: string // == Claude Code session id
  shortCode: string // e.g. "H7K", used in chat replies
  title: string
  cwd: string
  status: SessionStatus
  createdAt: number
  lastActivityAt: number
  workStartedAt?: number
  lastAssistantMessage?: string
  pending?: PendingPermission
  /** Claude Code is showing its first-run "trust this folder?" question. */
  trustPrompt?: boolean
  exitCode?: number
}

export type RemoteWhen = 'away' | 'always' | 'never'
export type InterceptMode = 'always' | 'away' | 'never'

export interface NotificationSettings {
  /** Play a chime when a session needs you or finishes while you're not looking at it. */
  sound: boolean
  soundVolume: number // 0..1
  /** When to forward to remote channels (Slack, Telegram, ...). Desktop toasts are always on. */
  remoteWhen: RemoteWhen
  /** Seconds without keyboard/mouse input before you count as away. */
  awayAfterSec: number
  /** Wait this long before forwarding, in case you handle it at the desk. */
  remoteDelaySec: number
  /** Only notify "finished" when the turn took at least this long. */
  finishedMinSec: number
  notifyOn: { permission: boolean; finished: boolean; waiting: boolean }
  /** Hold Claude's permission prompts so they can be answered from Hive or your phone. */
  interceptPermissions: InterceptMode
  /** How long a held permission prompt waits before falling back to the terminal dialog. */
  permissionTimeoutSec: number
}

export interface GeneralSettings {
  claudePath: string // empty = auto-detect
  /** Extra command-line arguments for every session, e.g. "--model opus". */
  extraArgs: string
  defaultCwd: string
  fontSize: number
  fontFamily: string
  /** Answer Claude Code's first-run "trust this folder?" with yes automatically. */
  autoTrustFolders: boolean
  /** Closing the window keeps Hive running in the tray. */
  closeToTray: boolean
  launchAtLogin: boolean
  trayHintShown?: boolean
  /** Stop the computer sleeping on its idle timer while a session is working (or holding a permission prompt). */
  keepAwake: boolean
  /** Also keep running with the lid closed while sessions work, by switching the OS lid action temporarily. */
  lidClosed: LidMode
}

export type LidMode = 'off' | 'plugged-in' | 'always'

export interface PowerStatus {
  /** Hive is currently blocking idle sleep. */
  blocking: boolean
  /** Sessions keeping the computer awake right now. */
  activeSessions: number
  lid: {
    /** Whether this OS/machine lets Hive override the lid action at all. */
    supported: boolean
    /** Hive has changed the lid action and will restore it when sessions finish. */
    engaged: boolean
    /** Human-readable note: why unsupported, last error, or what is in effect. */
    message?: string
  }
}

export interface AssistantSettings {
  /** Plain-language description of what matters, given to the triage model. */
  interests: string
  /** Senders that always alert (no AI triage). Email address, @domain, or name; one per entry. */
  vipSenders: string[]
  /** Senders that never alert. Same format as vipSenders. */
  mutedSenders: string[]
  /** Model alias for `claude -p` triage, e.g. "haiku". */
  model: string
  /** Pause all triage and alerts without turning source plugins off. */
  paused: boolean
}

// ---- assistant (sources → triage → alerts) ----

/** Something a source plugin noticed (an email, a Slack DM, ...). Untrusted content. */
export interface SourceItem {
  /** Stable id within the source (dedupe key). */
  id: string
  from: string
  /** Display name of the sender, if known. */
  fromName?: string
  subject?: string
  /** Plain-text body or message, already trimmed by the plugin (Hive clips to 4000 chars). */
  text: string
  receivedAt: number
  /** Link that opens the item in its app (Gmail web, Slack permalink, ...). */
  url?: string
  /** Where it came from inside the source, e.g. "Inbox", "#general", "DM". */
  where?: string
}

export type AssistantVerdict = 'pending' | 'important' | 'not_important' | 'vip' | 'muted' | 'paused' | 'error'

export interface AssistantItem extends SourceItem {
  /** `${sourceId}:${id}` */
  key: string
  sourceId: string
  sourceLabel: string
  verdict: AssistantVerdict
  /** One-line reason from triage (or why it was skipped). */
  reason?: string
  /** One-line summary for the alert. */
  summary?: string
  /** A light one-liner to go with the alert (empty for serious matters). */
  quip?: string
  triagedAt?: number
  /** You've looked at it in the Inbox. */
  seen?: boolean
}

export interface AssistantStats {
  triagedToday: number
  alertsToday: number
  lastRunAt?: number
  lastError?: string
}

export interface PluginState {
  enabled: boolean
  settings: Record<string, unknown>
}

export interface HiveSettings {
  general: GeneralSettings
  notifications: NotificationSettings
  assistant: AssistantSettings
  plugins: Record<string, PluginState>
}

export type Presence = 'present' | 'away'
export type PresenceMode = 'auto' | 'present' | 'away'

// ---- plugins ----

export type PluginSettingType = 'string' | 'secret' | 'number' | 'boolean' | 'select' | 'text'

export interface PluginSettingField {
  key: string
  label: string
  type: PluginSettingType
  required?: boolean
  help?: string
  placeholder?: string
  default?: unknown
  options?: { value: string; label: string }[]
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  main: string
  hiveApi: number
  contributes?: {
    channel?: { id: string; label: string; supportsReplies?: boolean; supportsButtons?: boolean }
    /** The plugin feeds items (emails, messages) to the assistant via ctx.source.emit. */
    source?: { id: string; label: string }
  }
  settings?: PluginSettingField[]
  docs?: string
}

export type PluginRunState = 'disabled' | 'starting' | 'running' | 'error' | 'stopped'

export interface PluginInfo {
  manifest: PluginManifest
  dir: string
  builtin: boolean
  enabled: boolean
  runState: PluginRunState
  statusMessage?: string
  /** Settings with secrets masked (secret fields report only whether they are set). */
  settings: Record<string, unknown>
}

// ---- notifications ----

export type NotificationKind = 'permission' | 'finished' | 'waiting' | 'test' | 'info' | 'alert'

export interface OutboundAction {
  id: 'approve' | 'deny' | 'stop' | 'status' | 'mute'
  label: string
}

export interface OutboundMessage {
  id: string
  kind: NotificationKind
  sessionId?: string
  sessionCode?: string
  sessionTitle?: string
  cwd?: string
  title: string
  body: string
  /** Optional code block, e.g. a command awaiting approval. */
  detail?: string
  actions: OutboundAction[]
  /** Pre-rendered plain text (for simple channels). */
  text: string
  /** For 'info' acks: the thread to answer in (a threadRef this channel returned or received). */
  replyTo?: string
  /** For 'alert': link to open the item (email, Slack message). */
  url?: string
  /** For 'alert': which source raised it, e.g. "Gmail". */
  sourceLabel?: string
}

export interface InboundReply {
  channelId: string
  threadRef?: string
  actionId?: string
  text: string
  from?: string
}

// ---- history ----

export interface SearchHit {
  sessionId: string
  cwd: string
  title: string
  role: string
  ts: string
  snippet: string
}

export interface IndexStatus {
  available: boolean
  indexing: boolean
  sessions: number
  messages: number
  error?: string
}

export interface ActivityEntry {
  ts: number
  sessionCode?: string
  text: string
}
