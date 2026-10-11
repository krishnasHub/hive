// Telegram channel for Hive: Bot API with long polling, so no public URL is needed.
/** @typedef {import('@hive/plugin-sdk').PluginContext} PluginContext */
/** @typedef {import('@hive/plugin-sdk').OutboundMessage} OutboundMessage */

const API = 'https://api.telegram.org'
const MAX_LEN = 4000

let running = false
let abort = null

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function clip(s, n) {
  s = String(s ?? '')
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/** @param {OutboundMessage} m */
function render(m) {
  if (m.kind === 'info' || m.kind === 'test') return esc(clip(m.text, MAX_LEN))
  if (m.kind === 'alert') {
    const parts = [`<b>${esc(clip(m.title, 300))}</b>`]
    if (m.body) parts.push(esc(clip(m.body, 1800)))
    if (m.url && /^https?:\/\//i.test(m.url)) {
      parts.push(`<a href="${esc(m.url).replace(/"/g, '&quot;')}">Open${m.sourceLabel ? ` in ${esc(m.sourceLabel)}` : ''}</a>`)
    }
    parts.push('<i>Reply “mute” to stop alerts from this sender.</i>')
    return clip(parts.join('\n\n'), MAX_LEN)
  }
  const parts = [`<b>${esc(m.title)}</b>`]
  if (m.body) parts.push(esc(clip(m.body, 1800)))
  if (m.detail) parts.push(`<pre>${esc(clip(m.detail, 1500))}</pre>`)
  parts.push(
    `<i>${m.kind === 'permission' ? 'Tap a button, or reply “no, &lt;what to do instead&gt;”.' : 'Reply to this message to continue the session.'}</i>`
  )
  return clip(parts.join('\n\n'), MAX_LEN)
}

/** @param {PluginContext} ctx */
async function activate(ctx) {
  const token = String(ctx.settings.botToken || '')
  const chatId = String(ctx.settings.chatId || '').trim()

  async function call(method, body, signal) {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal
    })
    const json = await res.json().catch(() => ({}))
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description || res.status}`)
    return json.result
  }

  const me = await call('getMe').catch((err) => {
    ctx.setStatus('error', `Bot token rejected: ${err.message}`)
    throw err
  })
  ctx.setStatus(
    chatId ? 'running' : 'error',
    chatId ? `Connected as @${me.username}` : `Connected as @${me.username}. Now message the bot to get your chat ID.`
  )

  ctx.channel.register({
    async send(m) {
      if (!chatId) throw new Error('Set your chat ID first (message the bot to get it).')
      const body = { chat_id: chatId, text: render(m), parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      if (m.actions?.length) {
        body.reply_markup = { inline_keyboard: [m.actions.map((a) => ({ text: a.label, callback_data: a.id }))] }
      }
      if (m.replyTo) body.reply_parameters = { message_id: Number(m.replyTo), allow_sending_without_reply: true }
      const sent = await call('sendMessage', body)
      return { threadRef: String(sent.message_id) }
    },
    async test() {
      if (!chatId) throw new Error('Set your chat ID first (message the bot to get it).')
      await call('sendMessage', { chat_id: chatId, text: '🐝 Hive is connected. You will get notifications here.' })
      return 'Sent! Check Telegram.'
    },
    stop() {
      running = false
      abort?.abort()
    }
  })

  // Long-poll for messages and button taps.
  running = true
  let offset = ctx.storage.get('offset') || 0
  ;(async () => {
    let backoff = 1000
    while (running) {
      abort = new AbortController()
      try {
        const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, abort.signal)
        backoff = 1000
        for (const u of updates) {
          offset = u.update_id + 1
          ctx.storage.set('offset', offset)
          await handle(u)
        }
      } catch (err) {
        if (!running) return
        ctx.log.warn(err.message)
        await new Promise((r) => setTimeout(r, backoff))
        backoff = Math.min(backoff * 2, 60_000)
      }
    }
  })()

  async function handle(u) {
    if (u.callback_query) {
      const q = u.callback_query
      const from = String(q.message?.chat?.id ?? '')
      await call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {})
      if (!chatId || from !== chatId) return
      // Remove the buttons so they can't be tapped twice.
      await call('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {})
      ctx.channel.reply({ text: '', actionId: q.data, threadRef: String(q.message.message_id), from: q.from?.username || from })
      return
    }
    const msg = u.message
    if (!msg || typeof msg.text !== 'string') return
    const from = String(msg.chat.id)
    if (!chatId) {
      await call('sendMessage', {
        chat_id: from,
        text: `👋 Your chat ID is ${from}\nPaste it into Hive → Settings → Phone channels → Telegram → Your chat ID, then Save.`
      })
      return
    }
    if (from !== chatId) return // not the owner: ignore silently
    if (msg.text === '/start') return
    ctx.channel.reply({
      text: msg.text,
      threadRef: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      from: msg.from?.username || from
    })
  }
}

module.exports = {
  activate,
  deactivate() {
    running = false
    abort?.abort()
  }
}
