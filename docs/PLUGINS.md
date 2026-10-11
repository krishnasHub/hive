# Writing a Hive plugin

Hive plugins add **notification channels**: new ways for Hive to reach you and for you to answer. Slack, Telegram and WhatsApp are all ordinary plugins (see [`plugins/`](../plugins)), and yours works the same way.

## Anatomy

A plugin is a folder with a manifest and a CommonJS entry file:

```
~/.hive/plugins/notify-discord/
  hive-plugin.json
  index.js
```

Put it in `~/.hive/plugins/` (Settings → Phone channels → the `~/.hive/plugins` link opens the folder), restart Hive, and it shows up in Settings. A user plugin with the same `id` as a built-in one replaces it, which is handy while you hack on a copy.

### hive-plugin.json

```jsonc
{
  "id": "notify-discord",            // unique
  "name": "Discord",
  "version": "0.1.0",
  "description": "Shown under the name in Settings.",
  "main": "index.js",
  "hiveApi": 1,                      // plugin API version
  "contributes": {
    "channel": { "id": "discord", "label": "Discord", "supportsReplies": true, "supportsButtons": false }
  },
  "settings": [
    // Rendered as a form. type: string | secret | number | boolean | select | text
    { "key": "webhookUrl", "label": "Webhook URL", "type": "secret", "required": true, "help": "…" }
  ],
  "docs": "Setup steps shown in the plugin card."
}
```

`secret` fields are encrypted with the OS keychain and never written to `settings.json`. When settings change, Hive restarts the plugin.

### index.js

```js
/** @type {import('@hive/plugin-sdk').HivePlugin} */
module.exports = {
  async activate(ctx) {
    const url = String(ctx.settings.webhookUrl)

    ctx.channel.register({
      // Deliver a notification. Return a threadRef so replies can be matched to it.
      async send(message) {
        const res = await fetch(url + '?wait=true', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: message.text })
        })
        const sent = await res.json()
        return { threadRef: sent.id }
      },
      // Used by the "Send test message" button.
      async test() {
        await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '🐝 Hive test' }) })
        return 'Sent!'
      }
    })

    // When the user answers, hand it to Hive:
    // ctx.channel.reply({ text: 'yes', threadRef: '<id of the message they replied to>', from: 'alice' })
  }
}
```

## Source plugins (the assistant)

A plugin can also be a **source**: it watches something (an inbox, a chat app) and hands new items to Hive. Hive's assistant checks each one against your VIP and mute lists, asks Claude (`claude -p` with Haiku, no tools) whether it matters, and sends an alert through your phone channels if it does. Gmail (`plugins/source-gmail`) is a source. The Slack plugin is both a channel and a source.

Declare it in the manifest:

```jsonc
"contributes": { "source": { "id": "gmail", "label": "Gmail" } }
```

Then hand items over as they arrive:

```js
ctx.source.register({ async test() { return 'Connected.' } }) // powers "Test connection"
ctx.source.emit([{
  id: msg.id,                 // stable; items already seen are ignored
  from: 'jane@acme.com',      // address or handle, matched against VIP/mute lists
  fromName: 'Jane Doe',
  subject: 'Prod is down',
  text: 'Customers cannot log in…', // plain text, keep it under ~4000 characters
  receivedAt: Date.now(),
  url: 'https://mail.google.com/…',  // opens the item; shown on the alert
  where: 'Inbox'
}])
```

- Only emit what's new since you started. Don't replay a whole inbox on first run.
- Item content is treated as untrusted data. It is shown to Claude inside data tags, with no tools available, and it never reaches a Claude Code session automatically.
- Hive dedupes by `id`, caps how many items it checks a day, and clips long text. Even so, filter cheaply in the plugin first (e.g. skip promotions) to save Claude usage.

## The context object

| | |
|---|---|
| `ctx.settings` | Values of your declared settings, with secrets decrypted |
| `ctx.channel.register(impl)` | `impl.send(msg)`, plus optional `impl.test()` and `impl.stop()` |
| `ctx.channel.reply({ text, threadRef?, actionId?, from? })` | Passes the user's answer to Hive |
| `ctx.source.register(impl)` / `ctx.source.emit(items)` | For source plugins: `impl.test()`, `impl.stop()`; hand new items to the assistant |
| `ctx.setStatus('running' \| 'error', message?)` | The status shown in Settings |
| `ctx.storage.get/set` | Small persistent JSON store (e.g. a polling offset) |
| `ctx.dataDir` | A private folder for your files |
| `ctx.log.info/warn/error` | Written to `~/.hive/logs/plugin-<id>.log` |

Full types are in [`packages/plugin-sdk/index.d.ts`](../packages/plugin-sdk/index.d.ts).

## Messages you'll be asked to send

`message.kind` is one of:

- `permission`: Claude wants to run a tool. `detail` holds the command or path. `actions` holds Approve/Deny. If your channel has buttons, send back `actionId: 'approve' | 'deny'`.
- `waiting`: Claude asked a question or is waiting for input.
- `finished`: a long turn ended. `body` holds Claude's last message.
- `info`: an acknowledgement ("✓ Approved [H7K]") or an error. `replyTo` is the threadRef to answer under.
- `alert`: the assistant thinks an email or message needs the user. `url` links to it and `sourceLabel` names the source. `actions` holds Mute sender (`actionId: 'mute'`). Replies in an alert's thread go to the assistant, not to a session. "mute" stops alerts from that sender.
- `test`: from the Send test message button.

`message.text` is a ready-made plain-text rendering. Use it unless your channel supports richer formatting.

## Replies and routing

Hive works out which session a reply is for in this order:

1. The `threadRef` matches a message you returned from `send`.
2. The text starts with a session code (`H7K: …`).
3. The last session notified on your channel.
4. The only running session.

Hive then reads the text: `yes` and `no` (optionally followed by a note), `stop`, `status`, or anything else, which becomes a prompt.

## Rules of the road

- **Accept replies only from the configured owner.** Check the sender (user ID, chat ID, phone number) and drop everything else. Anyone who can reply can approve commands on the user's machine.
- Keep `send` fast (under 30 s) and throw on failure. Hive logs the error and carries on with other channels.
- Prefer outbound connections (long polling, WebSockets). Hive runs on a laptop with no public URL. If a service insists on webhooks, use a relay like [`relay/whatsapp-relay`](../relay/whatsapp-relay).
- Each plugin runs in its own process with full Node.js access. There is no sandbox yet, so plugins are trusted code.
