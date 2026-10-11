# Hive — Design (v0.1)

> A cross-platform desktop "hive" for running many Claude Code sessions side by side, with a
> terminal-faithful UI, rich input (links, images), plugins, searchable history, and a
> **remote loop**: Claude needs you → your phone pings → you reply in Slack/WhatsApp →
> Claude carries on.

---

## 1. Goals and non-goals

**Goals**
1. Multi-tab Claude Code sessions that look and feel like the terminal.
2. Clickable links (open in default browser), paste/drag images Claude can analyse.
3. Plugins: install, enable/disable, and *create* new ones (with Claude's help).
4. Import agents, skills, and MCP servers; manage them per project or globally.
5. Search across all historic sessions and resume any of them.
6. Connectors for Outlook, Gmail, WhatsApp, Slack, etc. — delivered as plugins.
7. Notification + reply loop: Hive notices a session is waiting, pings you on your phone,
   and routes your reply back into the right session.

**Non-goals (v1)**
- Re-implementing Claude Code's agent loop. Hive wraps the real `claude` CLI.
- A mobile app. The phone side is Slack/WhatsApp/Telegram, which you already have.
- Multi-user / team features.

---

## 2. Key decision: wrap the CLI, don't rebuild it

| Option | Pros | Cons |
|---|---|---|
| **A. PTY-wrap the `claude` CLI** (recommended) | Pixel-identical terminal experience; every slash command, plugin, skill, MCP, `/resume` just works; uses your existing Claude login | Need hooks to get structured events (we have them — see §5) |
| B. Claude Agent SDK + custom chat UI | Fully structured events, easy permission callbacks | Not a terminal; re-implement lots of UX; subscription login can't be used by third-party apps built on the SDK — needs an API key (pay per token) |

**Recommendation: A, with Claude Code hooks as the structured event channel.** Keep an
abstraction (`SessionBackend`) so an SDK backend can be added later for headless/background
jobs.

---

## 3. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Shell | **Electron** | Mature `node-pty` support, `shell.openExternal`, native notifications, tray, auto-update; JS plugin ecosystem |
| UI | React + TypeScript + Vite | |
| Terminal | **xterm.js** (+ `addon-web-links`, `addon-webgl`, `addon-search`, `addon-fit`, `addon-unicode11`) | Same engine as VS Code's terminal |
| PTY | `node-pty` | ConPTY on Windows, forkpty on mac/Linux |
| Local DB | SQLite (`node:sqlite`, in a worker) with **FTS5** (+ optional `sqlite-vec` for semantic search) | Single file, fast, no server |
| Secrets | OS keychain via Electron `safeStorage` | OAuth tokens for Gmail/Slack/etc. |
| Packaging | `electron-builder` | `.exe`/MSIX, `.dmg`, `.deb`/AppImage |

**Platforms:** Windows ✅, macOS ✅, Linux ✅, **ChromeOS via the Linux (Crostini) container**
using the `.deb` (Electron runs fine there; Claude Code installs inside the same container).

Alternative considered: Tauri (smaller binary) — rejected for v1 because the plugin host and
PTY story are simpler in Node.

---

## 4. Architecture

```
┌──────────────────────────── Electron Renderer (React) ─────────────────────────────┐
│  Tab bar · Sidebar (projects, sessions, plugins) · xterm.js panes · Search · Inbox │
└──────────────────────────────────────▲─────────────────────────────────────────────┘
                                       │ typed IPC (contextBridge)
┌──────────────────────────────────────┴─── Electron Main ────────────────────────────┐
│                                                                                     │
│  SessionManager ──spawns──▶ node-pty ──▶ `claude` (one per tab, own cwd)           │
│        ▲                                    │                                       │
│        │ state changes                      │ hooks fire (Stop, Notification,       │
│        │                                    ▼ PermissionRequest, SessionStart…)     │
│  EventBus ◀──────────────── HookServer (127.0.0.1:<port>, per-launch token)         │
│     │  │                                                                            │
│     │  └──▶ NotificationRouter ──▶ channels: desktop toast · Slack · WhatsApp · …    │
│     │              ▲                                                                │
│     │              └── ReplyRouter ◀── inbound replies from channel plugins          │
│     │                                                                               │
│     ├──▶ HistoryIndexer (watches ~/.claude/projects/**.jsonl → SQLite FTS)          │
│     ├──▶ ConfigManager (agents, skills, MCP servers, Claude Code plugins)           │
│     └──▶ PluginHost (each plugin in its own utilityProcess, capability-scoped)      │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
                     │ optional
                     ▼
        Hive Relay (tiny Cloudflare Worker) — only for channels that need a public
        webhook (WhatsApp Cloud API). Forwards to the desktop over an outbound WebSocket.
```

### 4.1 Session model
```ts
type Session = {
  id: string;               // Hive id; short code like "H7K" used in chat replies
  claudeSessionId?: string; // from SessionStart hook; enables `claude --resume`
  title: string;            // auto from first prompt, editable
  cwd: string;
  state: 'starting' | 'working' | 'waiting_input' | 'waiting_permission' | 'idle' | 'exited';
  lastActivityAt: number;
  pendingRequest?: PendingRequest; // what Claude is waiting on
};
```
Tabs persist across app restarts: on relaunch Hive respawns `claude --resume <id>` in the
saved cwd.

---

## 5. How Hive "knows" what Claude is doing — hooks

**Implemented approach (verified against Claude Code 2.1.x):** every tab is launched as

```
claude --session-id <uuid> --settings ~/.hive/run/<uuid>.json [extra args]
```

That per-session settings file registers Claude Code **`type: "http"` hooks** that POST to
`http://127.0.0.1:<port>/hook/<uuid>/<Event>` with `Authorization: Bearer <per-launch token>`.
No helper script and no edits to `~/.claude/settings.json`; hooks from `--settings` add to the
user's own hooks.

| Hook | Hive uses it for |
|---|---|
| `UserPromptSubmit` | state → `working`; tab title from first prompt |
| `PreToolUse` / `PostToolUse(Failure)` | still working; clears any answered permission |
| `PermissionRequest` | **held open** (timeout = "hold permission prompts for", default 6h) until answered in Hive's Allow/Deny bar or from the phone; Hive returns `hookSpecificOutput.decision` |
| `Notification` | `permission_prompt` (when not held), `idle_prompt` / `agent_needs_input` / `elicitation_dialog` → waiting |
| `Stop` / `StopFailure` | state → `idle`; "finished" with `last_assistant_message` |
| `SessionEnd` | `exited` (except `/clear` and `/resume`, which keep the process) |

Findings from testing:
- `SessionStart` does not fire for http hooks, so Hive treats "the TUI has drawn and gone quiet"
  as ready.
- `/clear` and `/resume` change Claude's `session_id`; Hive follows `payload.session_id` so a
  restarted tab resumes the right conversation.
- A Hive launched from inside a Claude Code session inherits session markers
  (`CLAUDE_CODE_CHILD_SESSION`, …) that disable transcript saving; Hive strips them from child envs.
- First run in an untrusted folder shows Claude's trust dialog (default "No, exit"); the user
  answers it in the terminal.

**Injecting a reply:** idle/working sessions get the text as a bracketed paste followed by Enter
(Claude queues input while working). A held permission is resolved through the hook. If a
permission is *not* held (intercept mode "never"), Hive falls back to Enter (= Yes) / Esc (= No)
on Claude's own dialog.

## 6. Terminal UX features

- **Links:** `addon-web-links` + OSC 8 hyperlinks → `shell.openExternal(url)` (http/https/mailto
  only; file paths open in the OS file manager or your editor, configurable).
- **Images:** on paste/drag-drop of an image, Hive saves it to
  `~/.hive/attachments/<session>/<ts>.png`, shows a thumbnail chip above the prompt, and
  inserts the file path into the input. Claude Code reads image paths natively.
- **Files:** drag any file → inserts quoted path.
- Split panes, tab groups per project, rename/colour tabs, status dot per tab
  (working / waiting / idle / error), unread badge.
- Command palette (Ctrl/Cmd+K): new session in project, jump to tab, search history,
  run plugin command.
- Themes (match terminal themes), font settings, ligatures.

---

## 7. History & search

- **Source of truth:** Claude Code already writes transcripts to
  `~/.claude/projects/<project>/<session>.jsonl`. Hive does not duplicate the agent's memory;
  it **indexes** these files.
- `HistoryIndexer` tails new/changed files → SQLite tables `sessions`, `messages`
  (role, text, tool name, ts) with FTS5.
- Optional semantic search: embed message chunks locally (small ONNX model) into `sqlite-vec`.
- UI: search with filters (project, date, has-tool, role) → result preview → **Resume** (new tab
  with `claude --resume`) or **Copy into current session** (paste an excerpt as context).

---

## 8. Agents, skills, MCP servers ("Library")

Hive is a manager UI over the files Claude Code already understands — no proprietary format.

- **Agents:** `.claude/agents/*.md` (project) and `~/.claude/agents/*.md` (user).
- **Skills / Claude Code plugins:** surface installed plugins & marketplaces; install from URL/git.
- **MCP servers:** read/write `.mcp.json` (project) and user-scope config; add via form,
  paste JSON, or import from Claude Desktop config. "Test connection" button.
- Import sources: local folder, git URL, zip, marketplace.
- Scope toggle: Global vs. this project.

---

## 9. Hive plugin system

Two layers, deliberately separate:
1. **Claude Code plugins** (skills, agents, MCP, hooks) — extend *Claude*. Managed in §8.
2. **Hive plugins** — extend *Hive*: notification channels, connectors, UI panels, commands.

### 9.1 Hive plugin manifest
```jsonc
// hive-plugin.json
{
  "id": "hive-slack",
  "name": "Slack",
  "version": "0.1.0",
  "main": "dist/index.js",
  "capabilities": ["channel", "settings-panel"],
  "permissions": ["network:slack.com", "secrets", "events:session"],
  "settings": { "schema": "./settings.schema.json" },
  "mcp": { "optional": "./mcp.json" }   // can also expose tools to Claude
}
```

### 9.2 Plugin API (TypeScript SDK `@hive/plugin-sdk`)
```ts
export default definePlugin({
  activate(ctx) {
    ctx.channels.register({            // notification + reply channel
      id: 'slack',
      send: async (msg: OutboundMessage) => ({ threadRef }),
      onReply: (cb) => /* call cb({ threadRef, text, from }) */,
    });
    ctx.commands.register('slack.test', () => ...);
    ctx.events.on('session.waiting', (e) => ...);
    ctx.ui.panel({ id: 'slack', title: 'Slack', render: ... });
    ctx.secrets.get('botToken');
  },
});
```

### 9.3 Isolation & safety
- Each plugin runs in its own Electron `utilityProcess`; talks to Main over a message port.
- Permissions declared in manifest and approved at install (network hosts, secrets, events,
  PTY write). PTY write is a high-trust permission.
- Content from connectors (emails, messages) is **untrusted** — never auto-fed to Claude as
  instructions; it's presented as data.

### 9.4 "Create a plugin"
`New Plugin` → choose template (channel, connector, panel, command) → Hive scaffolds a folder
and opens a Claude tab in it with a pre-loaded brief + a `hive-plugin-authoring` skill.
`hive plugin dev` hot-reloads it into the running app.

---

## 10. Connectors (as plugins)

| Connector | Mechanism | Public URL needed? | Notes |
|---|---|---|---|
| **Slack** | Bot + **Socket Mode** | No | Best first channel. DM from bot, reply in thread. |
| **Telegram** | Bot API long polling | No | Easiest phone channel; great fallback. |
| **WhatsApp** | **WhatsApp Business Cloud API** | Yes → Hive Relay | Needs a Meta business app + number. Unofficial "WhatsApp Web" libraries risk your account being banned — avoid. |
| **Gmail** | Google OAuth + Gmail API (or Gmail MCP) | No | Read/search/draft; optional as a notification channel. |
| **Outlook** | Microsoft Graph OAuth | No | Mail + Teams later. |
| Desktop / phone push | OS notifications; optional ntfy/Pushover | No | Push-only channels (no reply), or reply via link. |

Connectors can do two jobs: **channel** (notify/reply) and **tools for Claude** (expose
an MCP server so Claude can, e.g., search your inbox).

---

## 11. The remote loop (the headline feature)

### 11.1 Flow
```
You (in Hive): "run the migration and full test suite"            [session H7K]
  └─ UserPromptSubmit → state=working, timer starts
… you walk away (Hive sees OS idle > N min, or you clicked "I'm away") …
Claude hits a permission prompt  → PermissionRequest hook (held)
  └─ NotificationRouter: you're away & session waiting > 30s → send to Slack:
       🐝 [H7K] api-server · waiting for permission
       Bash: `npm run db:migrate -- --env=staging`
       Reply: "yes" / "no" / or any instruction
You reply in the Slack thread on your phone: "yes, but skip seed data"
  └─ Slack plugin → ReplyRouter (thread → H7K) → resolve hook: allow + message
Claude continues. On Stop:
       ✅ [H7K] finished · "Migration applied, 412/412 tests passing" — reply to continue
You reply: "great, open a PR"  → typed into H7K's prompt → Claude continues
```

### 11.2 Routing rules
- Every outbound message carries the session short code; replies map by **thread** (Slack),
  **reply-to message id** (WhatsApp/Telegram), or a leading `H7K:` prefix as fallback.
- Only replies from **allowlisted sender IDs** are accepted.
- Reply grammar: `yes`/`y`/`approve`, `no`/`deny`, `stop` (interrupt), `status`
  (send last N lines), anything else = free-text prompt.
- Optional "dangerous action" policy: e.g. `rm -rf`, `git push --force`, prod commands require
  a typed confirmation code rather than "yes".

### 11.3 When to notify ("presence")
- Presence = `active` / `away` from `powerMonitor.getSystemIdleTime()`, lock-screen events,
  or manual toggle in tray.
- Rules (per session or global): notify on `waiting_permission`, `waiting_input`, `finished
  after > X min`, `error`. Quiet hours. Batching/digest if many sessions fire at once.
- If you're active at the desk: desktop toast only.

### 11.4 Laptop sleeps?
Hive must stay awake while sessions are working (`powerSaveBlocker` while any tab is
`working`). If the machine sleeps, nothing runs anyway — documented limitation; later option:
run sessions on a home server/VM with Hive as a client.

---

## 12. Security model
- HookServer binds to `127.0.0.1`, random port, per-launch bearer token.
- Secrets in OS keychain; never written to plugin dirs or logs.
- Plugins sandboxed + permissioned (§9.3).
- Remote replies: sender allowlist, optional PIN for approvals, full audit log
  (`who/what/when/channel` per approval) visible in the Inbox.
- Relay (if used) is stateless, end-to-end signed messages (HMAC with a key only Hive and the
  relay share), no transcript content stored.
- Hive never modifies `~/.claude/settings.json` silently — shows a diff and backs it up.

---

## 13. Data layout
```
~/.hive/
  hive.db                 # sessions, tabs, index, audit log, notification log
  attachments/<session>/  # pasted images
  plugins/<id>/           # installed Hive plugins
  logs/
~/.claude/                # owned by Claude Code; Hive reads + carefully edits settings/hooks
```

---

## 14. Repo layout (monorepo, npm workspaces)
```
hive/
  apps/desktop/           # Electron app: src/core (pure, tested), src/main, src/preload, src/renderer
  packages/plugin-sdk/    # @hive/plugin-sdk type definitions
  plugins/                # built-in plugins: notify-slack (channel + source), notify-telegram,
                          # notify-whatsapp, source-gmail
  relay/whatsapp-relay/   # Cloudflare Worker (optional)
  docs/
```

---

## 15. Roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 · Spike** (≈1 wk) | Electron + xterm.js + node-pty running `claude`; links; image paste; verify hook payloads | Can use Claude Code in Hive as well as in Windows Terminal |
| **1 · Multi-session MVP** | Tabs/splits, persistence + resume, HookServer, state dots, desktop notifications, settings | Daily-drivable on Windows |
| **2 · Remote loop** | NotificationRouter, ReplyRouter, presence, **Slack** + **Telegram** channels, permission approval remotely, audit log | Approve a permission + send a follow-up from phone |
| **3 · History search** | Indexer, FTS search UI, resume/copy-into-session; optional semantic | Find any past conversation in < 1s |
| **4 · Plugins** | Plugin host, SDK, permissions, install/disable, "Create plugin" flow | Slack/Telegram rebuilt as real plugins |
| **5 · Library** | Agents/skills/MCP manager + importers | Add an MCP server without touching JSON |
| **6 · Connectors** | Gmail, Outlook, WhatsApp (+ relay) | Each usable as channel and/or Claude tool |
| **7 · Ship** | Code signing, auto-update, mac/Linux/ChromeOS builds | Installers for all platforms |

---

## 16. Decisions & status (Oct 2026)

- **Distribution:** open source (MIT), shared on git. Hive never handles Claude credentials;
  each user installs and signs into Claude Code themselves, and Hive drives that CLI.
- **Notifications are plugins**, and the user picks one or more channels. Built in: Slack (Socket
  Mode), Telegram (long polling), WhatsApp (beta, Cloud API + Cloudflare relay).
- **Done and tested end to end on Windows:** tabs/PTYs, http hooks, held permissions with an
  Allow/Deny bar, presence-aware notification router, plugin host, remote reply loop (with a
  mock channel), history index + search, resumable tabs.
- **Not yet verified with live accounts:** the Slack/Telegram/WhatsApp plugins themselves.
- **Assistant (Oct 2026):** source plugins (`contributes.source`, `ctx.source.emit`) feed items to
  `main/assistant.ts`. Mute/VIP rules come first, then batched triage through `claude -p --model haiku
  --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence --json-schema …` (uses
  the user's own login; about 2 s and 1.3k tokens per batch). Important items become `alert`
  notifications through the same router (presence, delay, channels). Replies in an alert thread
  go to the assistant ("mute"), never to a session. Gmail uses IMAP plus an app password: OAuth's
  restricted Gmail scopes would need Google verification, and in testing mode tokens expire after
  7 days. Slack watching lives in the Slack channel plugin, because Socket Mode spreads events
  across all connections of one app. There's no WhatsApp source: the official API can't read
  personal chats, and unofficial clients risk a ban.
- **Keep awake:** `powerSaveBlocker('prevent-app-suspension')` while sessions work or hold a
  permission prompt. With the opt-in lid setting, Windows temporarily sets the power-plan LIDACTION
  to 0, with the originals saved in `~/.hive/lid-override.json` and restored on quit or the next
  start. Linux holds `systemd-inhibit --what=handle-lid-switch`. macOS can't do this without sudo.
  No app can block a sleep the user chooses.
- **Next:** Outlook source (Microsoft Graph, device-code sign-in), Library (agents/MCP import, §8),
  split panes, command palette, code signing + auto-update, plugin permission enforcement.
