// Slack channel for Hive: DMs via the Web API, replies and button taps via Socket Mode (no public URL).
/** @typedef {import('@hive/plugin-sdk').PluginContext} PluginContext */
/** @typedef {import('@hive/plugin-sdk').OutboundMessage} OutboundMessage */

const API = 'https://slack.com/api'

const LINK_BLOCK = 'hive_link'
const LINK_ACTION = 'hive_open_link'
const BATCH_MS = 2000

let running = false
let socket = null
let flushTimer = null

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function clip(s, n) {
  s = String(s ?? '')
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/** @param {OutboundMessage} m */
function alertBlocks(m) {
  const b = [{ type: 'section', text: { type: 'mrkdwn', text: `*${esc(clip(m.title, 280))}*` } }]
  if (m.body) b.push({ type: 'section', text: { type: 'mrkdwn', text: esc(clip(m.body, 2900)) } })
  // The link lives in its own block so it survives the post-tap button swap in onInteractive.
  if (m.url && /^https?:\/\//i.test(m.url) && m.url.length <= 3000) {
    b.push({
      type: 'actions',
      block_id: LINK_BLOCK,
      elements: [
        {
          type: 'button',
          action_id: LINK_ACTION,
          url: m.url,
          text: { type: 'plain_text', text: clip(`Open in ${m.sourceLabel || 'app'}`, 75) }
        }
      ]
    })
  }
  if (m.actions?.length) {
    b.push({
      type: 'actions',
      block_id: 'hive_actions',
      elements: m.actions.map((a) => ({ type: 'button', action_id: a.id, value: a.id, text: { type: 'plain_text', text: a.label } }))
    })
  }
  b.push({ type: 'context', elements: [{ type: 'mrkdwn', text: esc('Reply “mute” to stop alerts from this sender') }] })
  return b
}

/** @param {OutboundMessage} m */
function blocks(m) {
  if (m.kind === 'info' || m.kind === 'test') {
    return [{ type: 'section', text: { type: 'mrkdwn', text: esc(clip(m.text, 2900)) } }]
  }
  if (m.kind === 'alert') return alertBlocks(m)
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

/** Turn Slack mrkdwn into plain text. `name(id)` returns a cached display name or undefined. */
function cleanText(text, name) {
  return String(text ?? '')
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, label) => '@' + (name(id) || label || id))
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<#([A-Z0-9]+)>/g, '#channel')
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]*)>/g, '$1')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<!date\^[^|>]*\|([^>]*)>/g, '$1')
    .replace(/<(?:mailto:)?([^|>]+)\|([^>]+)>/g, (_, url, label) => (label === url ? label : `${label} (${url})`))
    .replace(/<([^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
}

/** @param {PluginContext} ctx */
async function activate(ctx) {
  const botToken = String(ctx.settings.botToken || '')
  const appToken = String(ctx.settings.appToken || '')
  const userId = String(ctx.settings.userId || '').trim()
  const userToken = String(ctx.settings.userToken || '').trim()
  const watch = ['off', 'dms', 'dms-mentions'].includes(String(ctx.settings.watch)) ? String(ctx.settings.watch) : 'dms-mentions'
  const source = ctx.source // undefined in Hive builds without the assistant

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

  // Read methods (users.info, conversations.info, chat.getPermalink) don't reliably accept JSON bodies; use a form.
  async function apiForm(method, params, token) {
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${token}` },
      body: new URLSearchParams(params).toString()
    })
    const json = await res.json().catch(() => ({}))
    if (!json.ok) throw new Error(`Slack ${method}: ${json.error || res.status}`)
    return json
  }

  let dm
  let botUserId
  try {
    const auth = await api('auth.test')
    botUserId = auth.user_id
    dm = (await api('conversations.open', { users: userId })).channel.id
    ctx.setStatus('running', `Connected to ${auth.team} as ${auth.user}`)
  } catch (err) {
    ctx.setStatus('error', err.message)
    throw err
  }

  // ---- watching: the assistant source ----
  const watching = Boolean(source && watch !== 'off' && userToken)
  /** Whose DMs and mentions we watch: the owner of the user token (normally the configured member ID). */
  let me = userId
  let meName = ''
  if (watching) {
    try {
      const a = await apiForm('auth.test', {}, userToken)
      if (a.user_id) me = a.user_id
      meName = a.user || ''
      if (a.user_id && a.user_id !== userId) ctx.log.warn(`User token belongs to ${a.user_id}, not member ID ${userId}; watching ${a.user_id}.`)
    } catch (err) {
      ctx.log.warn(`User token check failed: ${err.message}`)
    }
  }

  function watchNote() {
    if (!source || watch === 'off') return ''
    if (!userToken) return ' · Not watching your Slack yet: add a User OAuth Token (see setup) to let the assistant see your DMs and mentions'
    return (watch === 'dms' ? ' · Watching your DMs' : ' · Watching your DMs and @mentions') + (meName ? ` as ${meName}` : '')
  }

  if (source) {
    try {
      source.register({
        async test() {
          if (watch === 'off') return 'Watching is off. Pick “My DMs” or “My DMs and @mentions”.'
          if (!userToken) throw new Error('No User OAuth Token. Update the app from the current manifest, reinstall it, and paste the xoxp-… token.')
          const a = await apiForm('auth.test', {}, userToken)
          return `Watching ${watch === 'dms' ? 'DMs' : 'DMs and mentions'} for ${a.user || a.user_id}`
        },
        stop() {
          if (flushTimer) clearTimeout(flushTimer)
          flushTimer = null
        }
      })
    } catch (err) {
      ctx.log.warn(`source.register failed: ${err.message}`)
    }
  }

  const names = new Map() // user id → display name
  const convs = new Map() // channel id → Promise<{ where, visible }>
  const seen = new Set()
  let pending = []

  async function userName(id) {
    if (names.has(id)) return names.get(id)
    let n
    for (const token of [botToken, userToken]) {
      if (!token) continue
      try {
        const u = (await apiForm('users.info', { user: id }, token)).user
        n = u?.profile?.display_name || u?.real_name || u?.profile?.real_name || u?.name
        if (n) break
      } catch {
        // try the other token
      }
    }
    if (n) names.set(id, n)
    return n
  }

  /** Where a message was posted, and whether the watched user is actually in that conversation. */
  function conversation(e) {
    if (!convs.has(e.channel)) {
      const p = (async () => {
        try {
          const c = (await apiForm('conversations.info', { channel: e.channel }, userToken)).channel
          if (c.is_im) return { where: 'DM', visible: c.user !== botUserId }
          if (c.is_mpim) return { where: 'Group DM', visible: c.is_member !== false }
          return { where: c.name ? `#${c.name}` : undefined, visible: c.is_member !== false }
        } catch (err) {
          // channel_not_found with the user token: a conversation the user isn't in (e.g. someone else DMing the Hive bot).
          ctx.log.info(`conversations.info ${e.channel}: ${err.message}`)
          return { where: undefined, visible: false }
        }
      })()
      convs.set(e.channel, p)
      if (convs.size > 500) convs.delete(convs.keys().next().value)
    }
    return convs.get(e.channel)
  }

  async function permalink(channel, ts) {
    for (const token of [userToken, botToken]) {
      try {
        return (await apiForm('chat.getPermalink', { channel, message_ts: ts }, token)).permalink
      } catch {
        // try the other token
      }
    }
    return undefined
  }

  function flush() {
    flushTimer = null
    const items = pending
    pending = []
    if (!items.length || !source) return
    try {
      source.emit(items)
    } catch (err) {
      ctx.log.warn(`source.emit failed: ${err.message}`)
    }
  }

  /** A message outside the owner's DM with Hive: maybe a DM or mention for the assistant. */
  async function onWatchedMessage(e) {
    if (!watching) return
    if (e.subtype && e.subtype !== 'file_share' && e.subtype !== 'thread_broadcast') return
    if (e.bot_id || !e.user || e.user === me || e.user === botUserId || !e.ts || !e.channel) return
    const type = e.channel_type
    const isDm = type === 'im' || type === 'mpim'
    if (!isDm) {
      if (watch !== 'dms-mentions') return
      if (!new RegExp(`<@${me}[|>]`).test(String(e.text || ''))) return
    }
    const id = `${e.channel}:${e.ts}`
    if (seen.has(id)) return
    seen.add(id)
    if (seen.size > 2000) seen.delete(seen.values().next().value)

    const conv = await conversation(e)
    if (!conv.visible) return

    const mentioned = [...new Set([...String(e.text || '').matchAll(/<@([UW][A-Z0-9]+)/g)].map((x) => x[1]))].slice(0, 10)
    const [fromName, url] = await Promise.all([userName(e.user), permalink(e.channel, e.ts), ...mentioned.map(userName)])
    let text = cleanText(e.text, (uid) => names.get(uid))
    if (Array.isArray(e.files) && e.files.length) {
      const files = e.files.map((f) => f?.name || f?.title).filter(Boolean)
      if (files.length) text += `${text ? '\n' : ''}[attached: ${files.join(', ')}]`
    }
    if (!text) return

    pending.push({
      id,
      from: e.user,
      fromName,
      text: clip(text, 4000),
      receivedAt: Math.round(parseFloat(e.ts) * 1000) || Date.now(),
      url,
      where: conv.where || (type === 'im' ? 'DM' : type === 'mpim' ? 'Group DM' : undefined)
    })
    if (!flushTimer) flushTimer = setTimeout(flush, BATCH_MS)
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
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = null
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
    ws.onopen = () => ctx.setStatus('running', `Connected (Socket Mode)${watchNote()}`)
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
    if (!e || e.type !== 'message') return
    if (e.channel === dm) {
      // The owner's DM with Hive: answers to sessions and alerts. Never a source item.
      if (e.subtype || e.bot_id) return
      if (e.user !== userId) return // only the owner
      ctx.channel.reply({ text: String(e.text || ''), threadRef: e.thread_ts, from: e.user })
      return
    }
    // Anything else can only reach us through the user token's user_events. A failure here must not touch the channel.
    try {
      onWatchedMessage(e).catch((err) => ctx.log.warn(`watch: ${err.message}`))
    } catch (err) {
      ctx.log.warn(`watch: ${err.message}`)
    }
  }

  async function onInteractive(p) {
    if (!p || p.type !== 'block_actions' || p.user?.id !== userId) return
    const action = p.actions?.[0]
    if (!action) return
    // Link buttons ("Open in Gmail") still send an interaction; the browser handles them.
    if (action.action_id === LINK_ACTION || action.block_id === LINK_BLOCK) return
    const msg = p.message
    const root = msg?.thread_ts || msg?.ts
    ctx.channel.reply({ text: '', actionId: action.action_id, threadRef: root, from: p.user.id })
    // Swap the buttons for a note so they can't be pressed twice (the "Open in …" link stays).
    if (msg && p.channel?.id && action.action_id !== 'status') {
      const kept = (msg.blocks || []).filter((b) => b.type !== 'actions' || b.block_id === LINK_BLOCK)
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
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
  }
}
