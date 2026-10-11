# Slack channel

DMs you from your own Slack app when a session needs you. Reply in the thread, or tap **Approve** / **Deny**.

- Socket Mode: Hive opens an outbound WebSocket, so no public URL or server is needed.
- Only the member ID you configure can answer. Messages from anyone else are ignored.
- `slack-app-manifest.yml` creates the app with the right scopes in one step.

## Watching your Slack (assistant source)

The same app can also feed Hive's assistant. With a **User OAuth Token** (xoxp-…) and **Watch** set, Hive passes
messages people send you to the assistant, which alerts you (here, or on any other channel) about the ones that need you.

- **My DMs**: direct messages and group DMs from other people.
- **My DMs and @mentions**: also channel messages that mention you.

Your own messages, bots, and your DM with Hive itself are never passed on. Hive only reads; it never posts as you.

Setting it up on an existing app: https://api.slack.com/apps → your Hive app → **App Manifest**, paste the current
`slack-app-manifest.yml` and Save (it adds read-only user scopes and `user_events`). Then **OAuth & Permissions →
Reinstall to Workspace** and copy the User OAuth Token into Hive.

The watcher lives in this plugin rather than a separate one because Slack spreads Socket Mode events across all
open connections of an app, so a second connection would steal half of the events.

Alerts arrive with an **Open in …** button and **Mute sender**. Reply “mute” in an alert's thread to stop alerts from that sender.
