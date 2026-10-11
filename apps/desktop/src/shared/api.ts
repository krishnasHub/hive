// The API the preload script exposes to the renderer as `window.hive`.
import type {
  ActivityEntry,
  AssistantItem,
  AssistantStats,
  HiveSettings,
  IndexStatus,
  PluginInfo,
  PowerStatus,
  Presence,
  PresenceMode,
  SearchHit,
  SessionInfo
} from './types'

export interface HiveApi {
  platform: string
  sessions: {
    list(): Promise<SessionInfo[]>
    create(opts: { cwd?: string; title?: string; resumeClaudeSessionId?: string }): Promise<SessionInfo>
    start(id: string): Promise<void>
    close(id: string): Promise<void>
    rename(id: string, title: string): Promise<void>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    scrollback(id: string): Promise<{ text: string; end: number }>
    answerPermission(id: string, requestId: string, answer: 'allow' | 'deny' | 'terminal'): Promise<void>
    interrupt(id: string): Promise<void>
    answerTrust(id: string, trust: boolean): Promise<void>
    onData(fn: (id: string, data: string, end: number) => void): () => void
    onUpdate(fn: (s: SessionInfo) => void): () => void
    onRemoved(fn: (id: string) => void): () => void
    onError(fn: (id: string, message: string) => void): () => void
    onFocus(fn: (id: string) => void): () => void
  }
  attachments: {
    /** Saves a pasted image and returns its absolute path. */
    saveImage(sessionId: string, bytes: ArrayBuffer, mime: string): Promise<string>
    pathForFile(file: File): string
  }
  settings: {
    get(): Promise<HiveSettings>
    update(patch: Partial<HiveSettings>): Promise<HiveSettings>
    detectClaude(): Promise<string | null>
  }
  plugins: {
    list(): Promise<PluginInfo[]>
    setEnabled(id: string, enabled: boolean): Promise<void>
    configure(id: string, values: Record<string, unknown>): Promise<void>
    test(id: string): Promise<{ ok: boolean; message: string }>
    openFolder(): Promise<void>
    onChange(fn: () => void): () => void
  }
  presence: {
    get(): Promise<{ presence: Presence; mode: PresenceMode }>
    setMode(mode: PresenceMode): Promise<void>
    onChange(fn: (p: { presence: Presence; mode: PresenceMode }) => void): () => void
  }
  history: {
    search(q: string): Promise<SearchHit[]>
    status(): Promise<IndexStatus>
    reindex(): Promise<void>
    onStatus(fn: (s: IndexStatus) => void): () => void
  }
  activity: {
    list(): Promise<ActivityEntry[]>
    onEntry(fn: (e: ActivityEntry) => void): () => void
  }
  assistant: {
    /** Recent items from source plugins, newest first, with their triage verdicts. */
    list(): Promise<AssistantItem[]>
    stats(): Promise<AssistantStats>
    /** Never alert for this sender again (adds to settings.assistant.mutedSenders). */
    muteSender(sender: string): Promise<void>
    /** Mark every item as seen (clears the Inbox badge). */
    markAllSeen(): Promise<void>
    /** Run triage again on items that errored. */
    retryErrors(): Promise<void>
    onChange(fn: () => void): () => void
    /** Clicking an alert's desktop notification asks the UI to show the Inbox. */
    onOpenInbox(fn: () => void): () => void
  }
  power: {
    status(): Promise<PowerStatus>
    onStatus(fn: (s: PowerStatus) => void): () => void
  }
  app: {
    openExternal(url: string): Promise<void>
    pickFolder(defaultPath?: string): Promise<string | null>
    showItem(path: string): Promise<void>
    /** Taskbar/dock badge with the number of sessions that need you (0 clears it). */
    setBadge(count: number, overlayDataUrl: string | null): void
  }
}
