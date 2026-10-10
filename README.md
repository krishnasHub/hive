# 🐝 Hive

**A desktop hive for Claude Code.** Run many Claude Code sessions in tabs, in a real terminal, and get a ping on your phone when one needs you. Reply from Slack, Telegram or WhatsApp, and Claude carries on.

```
You: "run the migration and the full test suite"          [tab H7K]
…you go make coffee…
📱 Slack: 🔐 [H7K] api-server needs permission
          Bash: npm run db:migrate -- --env=staging      [Approve] [Deny]
You (in the thread): "yes, but skip the seed data"
📱 ✓ Approved [H7K] and queued your note
…
📱 ✅ [H7K] api-server finished: "Migration applied, 412/412 tests passing"
You: "great, open a PR"
📱 ✓ Sent to [H7K]
```

## Features

- **Tabs of real Claude Code.** Each tab runs the `claude` CLI you already have, so slash commands, skills, MCP servers, plugins and `/resume` all work as usual.
- **Terminal comforts.** Click links to open them in your browser. Paste screenshots straight into the prompt (Hive saves them and hands Claude the file). Drag files in to insert their paths. Shift+Enter adds a newline.
- **Knows what each session is doing.** Status dots show *working*, *needs permission*, *waiting for you* or *ready*, using Claude Code's own hooks rather than screen-scraping.
- **Approve from anywhere.** Permission prompts show up as an Allow/Deny bar in Hive and as buttons on your phone.
- **Phone channels are plugins.** Slack, Telegram and WhatsApp ship with Hive. You can write your own in about 50 lines (see [docs/PLUGINS.md](docs/PLUGINS.md)).
- **Smart about when to ping.** Messages go to your phone only when you're away (idle or screen locked), after a short grace period. Nothing is sent if you answer at the desk first.
- **Search all your past sessions** (full-text, local) and resume any of them in a new tab.
- **Tabs survive restarts.** Reopen Hive and each tab resumes its conversation when you click it.
- **Chime and taskbar badge.** A bell plays when a session needs you or finishes in the background. The taskbar icon shows a red count (the Dock badge on macOS), and the taskbar button flashes until you look.
- **Audit log** of every notification and every action taken from your phone.

## Install and run (from source)

Requirements:
- [Claude Code](https://claude.com/claude-code), installed and logged in (`claude` works in your terminal)
- Node.js 20 or newer
- Linux only: build tools for `node-pty` (`sudo apt install build-essential python3`)

```sh
git clone <this repo> hive
cd hive
npm install
npm run dev        # run in development
npm run dist       # build an installer into apps/desktop/release/
```

| Platform | Package |
|---|---|
| Windows | `.exe` (NSIS installer) |
| macOS | `.dmg` |
| Linux | `.AppImage`, `.deb` |
| ChromeOS | Turn on *Linux development environment*, install Claude Code inside it, then install the `.deb` |

## Phone notifications in 2 minutes (Telegram)

1. In Telegram, message **@BotFather** → `/newbot`, and copy the token.
2. In Hive, open **Settings → Phone channels → Telegram**. Paste the token, Save, and turn the plugin on.
3. Send your bot any message. It replies with your chat ID. Paste that into Hive and Save.
4. Click **Send test message**.

Slack takes about 5 minutes (it has a ready-made app manifest). WhatsApp needs a Meta developer app and a free Cloudflare Worker. See each plugin's card in Settings, or [`plugins/`](plugins).

### Replying from your phone

| You send | What happens |
|---|---|
| `yes` / tap **Approve** | Allows the pending tool call |
| `yes, but skip the seeds` | Allows it, then sends your note to Claude |
| `no` / tap **Deny** | Denies it |
| `no, use the staging db` | Denies it and tells Claude what to do instead |
| `stop` | Interrupts Claude (like pressing Esc) |
| `status` | Replies with what the session is doing and its last message |
| anything else | Sent to Claude as your next prompt |

Reply in the notification's thread to target that session, or start your message with the session code: `H7K: run the tests again`.

## How it works

Hive starts each tab as `claude --session-id <id> --settings <hive-hooks.json>`. That settings file registers Claude Code **HTTP hooks** that point at a local server on `127.0.0.1`, protected by a random token. Hive holds `PermissionRequest` hooks open until you answer, in Hive or from your phone, and types your other replies into the session's prompt. Your own `~/.claude/settings.json` is never modified.

More detail is in [docs/DESIGN.md](docs/DESIGN.md).

## Security notes

- The hook server listens only on localhost and requires a per-launch token.
- Plugin secrets (bot tokens) are encrypted with your OS keychain (`safeStorage`).
- Each channel accepts replies only from the one account you configure (Slack member ID, Telegram chat ID, WhatsApp number). Anyone else is ignored.
- Plugins run in their own process but are **trusted code**. Only install plugins you trust.
- Approving a command from your phone is as powerful as approving it at your desk. Hive only forwards when you're away, and every remote action is logged in **Activity**.

## Project layout

```
apps/desktop/          Electron app (main, preload, renderer, pure core logic + tests)
packages/plugin-sdk/   Type definitions for plugin authors
plugins/               Built-in channel plugins: Slack, Telegram, WhatsApp
relay/whatsapp-relay/  Optional Cloudflare Worker that receives WhatsApp replies
docs/                  Design and plugin docs
```

## Status

Early (v0.1). Working and tested end to end on Windows: tabs, hooks, approvals, the remote reply loop and history search. The Slack, Telegram and WhatsApp plugins are written against their official APIs but still need testing with real accounts. On the roadmap: importing agents and MCP servers, connectors for Gmail and Outlook, split panes, and signed builds with auto-update.

Hive is an independent project. It is not made by or affiliated with Anthropic. It runs the Claude Code CLI you install and sign in to yourself.

## License

MIT
