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
  /** Closing the window keeps Hive running in the tray. */
  closeToTray: boolean
  launchAtLogin: boolean
  trayHintShown?: boolean
}

export interface PluginState {
  enabled: boolean
  settings: Record<string, unknown>
}

export interface HiveSettings {
  general: GeneralSettings
  notifications: NotificationSettings
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

export type NotificationKind = 'permission' | 'finished' | 'waiting' | 'test' | 'info'

export interface OutboundAction {
  id: 'approve' | 'deny' | 'stop' | 'status'
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
