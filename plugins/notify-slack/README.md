# Slack channel

DMs you from your own Slack app when a session needs you. Reply in the thread, or tap **Approve** / **Deny**.

- Socket Mode: Hive opens an outbound WebSocket, so no public URL or server is needed.
- Only the member ID you configure can answer. Messages from anyone else are ignored.
- `slack-app-manifest.yml` creates the app with the right scopes in one step.
