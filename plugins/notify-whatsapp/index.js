// WhatsApp channel for Hive (beta). Sends with the WhatsApp Business Cloud API and polls the Hive relay for replies.
/** @typedef {import('@hive/plugin-sdk').PluginContext} PluginContext */
/** @typedef {import('@hive/plugin-sdk').OutboundMessage} OutboundMessage */

const GRAPH = 'https://graph.facebook.com/v21.0'
const OUTSIDE_WINDOW = 131047 // "Re-engagement message": more than 24h since the user last wrote

let running = false
let abort = null

function clip(s, n) {
  s = String(s ?? '')
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/** @param {OutboundMessage} m */
function plain(m) {
  if (m.kind === 'info' || m.kind === 'test') return clip(m.text, 4000)
  if (m.kind === 'alert') {
    // Keep the body short so the link and hint survive the 1024-char limit on button messages.
    const parts = [`*${clip(m.title, 200)}*`]
    if (m.body) parts.push(clip(m.body, 600))
    if (m.url) parts.push(`${m.sourceLabel ? `Open in ${m.sourceLabel}` : 'Open'}: ${m.url}`)
    parts.push('_Reply "mute" to stop alerts from this sender._')
    return clip(parts.join('\n\n'), 4000)
  }
  const parts = [`*${m.title}*`]
  if (m.body) parts.push(clip(m.body, 1500))
  if (m.detail) parts.push('```' + clip(m.detail, 1200) + '```')
  parts.push(m.kind === 'permission' ? '_Reply "yes", "no", or "no, <what to do instead>"_' : '_Reply to this message to continue the session_')
  return clip(parts.join('\n\n'), 4000)
}

/** @param {PluginContext} ctx */
async function activate(ctx) {
  const s = ctx.settings
  const token = String(s.accessToken || '')
  const phoneId = String(s.phoneNumberId || '').trim()
  const to = String(s.recipient || '').replace(/\D/g, '')
  const relay = String(s.relayUrl || '').replace(/\/+$/, '')
  const relaySecret = String(s.relaySecret || '')
  const template = String(s.templateName || '').trim()
  const templateLang = String(s.templateLang || 'en_US').trim()

  /** Messages that couldn't be delivered outside the 24h window; sent when you next write. */
  let queued = []

  async function graph(body) {
    const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...body })
    })
    const json = await res.json().catch(() => ({}))
    if (json.error) {
      const err = new Error(`WhatsApp: ${json.error.message}`)
      err.code = json.error.code
      throw err
    }
    return json.messages?.[0]?.id
  }

  /** @param {OutboundMessage} m */
  function payload(m) {
    const context = m.replyTo ? { context: { message_id: m.replyTo } } : {}
    if (m.actions?.length && m.kind !== 'info') {
      return {
        ...context,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: clip(plain(m), 1024) },
          action: { buttons: m.actions.slice(0, 3).map((a) => ({ type: 'reply', reply: { id: a.id, title: clip(a.label, 20) } })) }
        }
      }
    }
    return { ...context, type: 'text', text: { body: plain(m), preview_url: false } }
  }

  async function deliver(m) {
    try {
      return await graph(payload(m))
    } catch (err) {
      if (err.code !== OUTSIDE_WINDOW) throw err
      if (!template) {
        ctx.setStatus('error', 'Outside WhatsApp’s 24-hour window. Send any message to your business number, or set a wake-up template.')
        throw err
      }
      queued.push(m)
      await graph({ type: 'template', template: { name: template, language: { code: templateLang } } })
      return undefined
    }
  }

  ctx.channel.register({
    async send(m) {
      const id = await deliver(m)
      // Thread on the message itself; replies carry it as context.id.
      return { threadRef: id }
    },
    async test() {
      await graph({ type: 'text', text: { body: '🐝 Hive is connected. You will get notifications here.' } })
      return 'Sent! Check WhatsApp.'
    },
    stop() {
      running = false
      abort?.abort()
    }
  })

  ctx.setStatus('running', 'Waiting for replies via relay')

  // Long-poll the relay for incoming messages.
  running = true
  let cursor = ctx.storage.get('cursor') || 0
  ;(async () => {
    let backoff = 1000
    while (running) {
      abort = new AbortController()
      try {
        const res = await fetch(`${relay}/poll?after=${cursor}`, {
          headers: { authorization: `Bearer ${relaySecret}` },
          signal: abort.signal
        })
        if (res.status === 401) throw new Error('Relay rejected the secret')
        if (!res.ok) throw new Error(`Relay error ${res.status}`)
        const data = await res.json()
        backoff = 1000
        for (const msg of data.messages || []) {
          cursor = Math.max(cursor, msg.seq)
          await handle(msg)
        }
        ctx.storage.set('cursor', cursor)
      } catch (err) {
        if (!running) return
        ctx.log.warn(err.message)
        ctx.setStatus('error', `Relay: ${err.message}`)
        await new Promise((r) => setTimeout(r, backoff))
        backoff = Math.min(backoff * 2, 60_000)
      }
    }
  })()

  async function handle(msg) {
    if (String(msg.from).replace(/\D/g, '') !== to) return // only the owner
    ctx.setStatus('running', 'Connected')
    // You wrote to us, so the 24h window is open: flush anything we couldn't send.
    if (queued.length) {
      const pending = queued
      queued = []
      for (const m of pending) await deliver(m).catch((err) => ctx.log.warn(err.message))
      // This message was you waking the chat up, not an answer; don't send it to Claude.
      return
    }
    ctx.channel.reply({
      text: String(msg.text || ''),
      actionId: msg.buttonId || undefined,
      threadRef: msg.contextId || undefined,
      from: String(msg.from)
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
