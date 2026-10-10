// Type definitions for Hive plugins (hiveApi 1).
// Use from plain JS with:  /** @param {import('@hive/plugin-sdk').PluginContext} ctx */

export interface OutboundAction {
  id: 'approve' | 'deny' | 'stop' | 'status'
  label: string
}

/** A notification Hive wants delivered. */
export interface OutboundMessage {
  id: string
  /** permission: Claude wants to run a tool. finished: a long turn ended. waiting: Claude asked you something.
   *  test: "Send test message". info: an acknowledgement or error, usually threaded under `replyTo`. */
  kind: 'permission' | 'finished' | 'waiting' | 'test' | 'info'
  sessionId?: string
  /** Short code like "H7K" that identifies the session in replies. */
  sessionCode?: string
  sessionTitle?: string
  cwd?: string
  title: string
  body: string
  /** Code to show in a monospace block (e.g. the command awaiting approval). */
  detail?: string
  /** Buttons to offer, if your channel supports them. Send the id back as `actionId`. */
  actions: OutboundAction[]
  /** Ready-made plain-text rendering of the whole message. */
  text: string
  /** For `info` messages: a threadRef to reply under. */
  replyTo?: string
}

export interface SendResult {
  /** Opaque id for the message or thread. Replies that carry it are routed to the right session. */
  threadRef?: string
}

export interface ChannelImpl {
  send(message: OutboundMessage): Promise<SendResult | void> | SendResult | void
  /** Called by "Send test message". Return a short status string or throw. */
  test?(): Promise<string | void> | string | void
  stop?(): Promise<void> | void
}

export interface InboundReply {
  text: string
  /** The threadRef of the message being replied to (thread ts, reply_to id, ...). */
  threadRef?: string
  /** Set when the user tapped a button: 'approve' | 'deny' | 'status' | 'stop'. */
  actionId?: string
  /** Who sent it (for the audit log). Only forward replies from the configured owner. */
  from?: string
}

export interface PluginContext {
  hiveApi: 1
  /** Values for the fields declared in hive-plugin.json (secrets decrypted). Restarted on change. */
  settings: Readonly<Record<string, unknown>>
  /** Private folder for this plugin's files. */
  dataDir: string
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void }
  /** Small persistent key/value store (JSON). */
  storage: { get<T = unknown>(key: string): T | undefined; set(key: string, value: unknown): void }
  /** Shown in Settings next to the plugin. */
  setStatus(state: 'running' | 'error', message?: string): void
  channel: {
    register(impl: ChannelImpl): void
    /** Deliver a reply from the user to Hive. */
    reply(reply: InboundReply): void
  }
}

export interface HivePlugin {
  activate(ctx: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}
