// Slack channel for Hive: DMs via the Web API, replies and button taps via Socket Mode (no public URL).
/** @typedef {import('@hive/plugin-sdk').PluginContext} PluginContext */
/** @typedef {import('@hive/plugin-sdk').OutboundMessage} OutboundMessage */

const API = 'https://slack.com/api'

let running = false
let socket = null

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function clip(s, n) {
  s = String(s ?? '')
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/** @param {OutboundMessage} m */
function blocks(m) {
  if (m.kind === 'info' || m.kind === 'test') {
    return [{ type: 'section', text: { type: 'mrkdwn', text: esc(clip(m.text, 2900)) } }]
  }
  const b = [{ type: 'section', text: { type: 'mrkdwn', text: `*${esc(clip(m.title, 280))}*` } }]
  if (m.body) b.push({ type: 'section', text: { type: 'mrkdwn', text: esc(clip(m.body, 2900)) } })
  if (m.detail) b.push({ type: 'section', text: { type: 'mrkdwn', text: '```' + esc(clip(m.detail, 2800)) + '```' } })
  if (m.actions?.length) {
    b.push({
      type: 'actions',
      block_id: 'hive_actions',
      elements: m.actions.map((a) => ({
        type: 'button',
        action_id: a.id,
        value: a.id,
        text: { type: 'plain_text', text: a.label },
        ...(a.id === 'approve' ? { style: 'primary' } : a.id === 'deny' ? { style: 'danger' } : {})
      }))
    })
  }
  const hint =
    m.kind === 'permission' ? 'Reply in thread: “yes”, “no”, or “no, <what to do instead>”' : 'Reply in this thread to continue the session'
  b.push({ type: 'context', elements: [{ type: 'mrkdwn', text: esc(hint) }] })
  return b
}

/** @param {PluginContext} ctx */
async function activate(ctx) {
  const botToken = String(ctx.settings.botToken || '')
  const appToken = String(ctx.settings.appToken || '')
  const userId = String(ctx.settings.userId || '').trim()

  async function api(method, body, token = botToken) {
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
      body: JSON.stringify(body ?? {})
    })
    const json = await res.json().catch(() => ({}))
    if (!json.ok) throw new Error(`Slack ${method}: ${json.error || res.status}`)
    return json
  }

  let dm
  try {
    const auth = await api('auth.test')
    dm = (await api('conversations.open', { users: userId })).channel.id
    ctx.setStatus('running', `Connected to ${auth.team} as ${auth.user}`)
  } catch (err) {
    ctx.setStatus('error', err.message)
    throw err
  }

  ctx.channel.register({
    async send(m) {
      const body = { channel: dm, text: clip(m.text, 3000), blocks: blocks(m), unfurl_links: false, unfurl_media: false }
      if (m.replyTo) body.thread_ts = m.replyTo
      const r = await api('chat.postMessage', body)
      return { threadRef: m.replyTo || r.ts }
    },
    async test() {
      await api('chat.postMessage', { channel: dm, text: '🐝 Hive is connected. You will get notifications here.' })
      return 'Sent! Check your Slack DMs.'
    },
    stop() {
      running = false
      socket?.close()
    }
  })

  running = true
  void connect(0)

  async function connect(attempt) {
    if (!running) return
    let url
    try {
      url = (await api('apps.connections.open', {}, appToken)).url
    } catch (err) {
      ctx.setStatus('error', `Socket Mode: ${err.message}`)
      return retry(attempt)
    }
    const ws = new WebSocket(url)
    socket = ws
    ws.onopen = () => ctx.setStatus('running', 'Connected (Socket Mode)')
    ws.onmessage = (ev) => {
      let env
      try {
        env = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id }))
      if (env.type === 'disconnect') ws.close()
      else if (env.type === 'events_api') onEvent(env.payload?.event)
      else if (env.type === 'interactive') void onInteractive(env.payload)
    }
    ws.onclose = () => {
      if (socket === ws) socket = null
      if (running) retry(0)
    }
    ws.onerror = () => {}
  }

  function retry(attempt) {
    if (!running) return
    const delay = Math.min(1000 * 2 ** attempt, 60_000)
    setTimeout(() => void connect(attempt + 1), delay)
  }

  function onEvent(e) {
    if (!e || e.type !== 'message' || e.subtype || e.bot_id) return
    if (e.user !== userId || e.channel !== dm) return // only the owner, only in our DM
    ctx.channel.reply({ text: String(e.text || ''), threadRef: e.thread_ts, from: e.user })
  }

  async function onInteractive(p) {
    if (!p || p.type !== 'block_actions' || p.user?.id !== userId) return
    const action = p.actions?.[0]
    if (!action) return
    const msg = p.message
    const root = msg?.thread_ts || msg?.ts
    ctx.channel.reply({ text: '', actionId: action.action_id, threadRef: root, from: p.user.id })
    // Swap the buttons for a note so they can't be pressed twice.
    if (msg && p.channel?.id && action.action_id !== 'status') {
      const kept = (msg.blocks || []).filter((b) => b.type !== 'actions')
      kept.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `→ *${esc(action.text?.text || action.action_id)}*` }] })
      await api('chat.update', { channel: p.channel.id, ts: msg.ts, text: msg.text || 'Hive', blocks: kept }).catch((err) =>
        ctx.log.warn(err.message)
      )
    }
  }
}

module.exports = {
  activate,
  deactivate() {
    running = false
    socket?.close()
  }
}
