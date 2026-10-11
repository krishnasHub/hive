// Gmail source for Hive: polls the inbox over IMAP (app password, read-only) and hands new mail to Hive for triage.
/** @typedef {import('@hive/plugin-sdk').PluginContext} PluginContext */
/** @typedef {import('@hive/plugin-sdk').SourceItem} SourceItem */

const { ImapClient, fetchBody, quote } = require('./imap')
const { parseMessage, cleanText } = require('./mime')

const MAX_PER_POLL = 25
const MAX_TEXT = 3500
const MAX_BACKOFF_MS = 30 * 60_000
const AUTH_BACKOFF_MS = 15 * 60_000
const CURSOR_KEY = 'cursor'
const FETCH_ITEMS = '(UID X-GM-MSGID X-GM-THRID X-GM-LABELS INTERNALDATE BODY.PEEK[]<0.65536>)'

let current = null

function buildQuery({ skipCategories = true, onlyImportant = false } = {}) {
  let q = 'in:inbox'
  if (skipCategories) q += ' -category:promotions -category:social -category:forums'
  if (onlyImportant) q += ' is:important'
  return q
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }

/** IMAP INTERNALDATE "10-Oct-2026 09:15:00 +0200" -> ms since epoch. */
function parseInternalDate(s) {
  const m = /(\d{1,2})-(\w{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})/.exec(String(s || ''))
  if (!m) return NaN
  const mon = MONTHS[m[2].toLowerCase()]
  if (mon == null) return NaN
  const off = (Number(m[8]) * 60 + Number(m[9])) * (m[7] === '-' ? -1 : 1)
  return Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - off * 60_000
}

function hhmm(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Turn IMAP / network errors into something a person can act on. */
function friendlyError(err) {
  const msg = String(err?.imapText || err?.message || err)
  const code = String(err?.code || '')
  if (/^Add your Gmail/.test(msg)) return msg
  if (/application-specific password/i.test(msg))
    return 'Gmail needs an app password, not your normal password. Create one at https://myaccount.google.com/apppasswords.'
  if (/web ?login required|WEBALERT/i.test(msg) || code === 'WEBALERT')
    return 'Google blocked the sign-in. Open https://accounts.google.com, confirm it was you, then try again.'
  if (/not enabled for IMAP/i.test(msg)) return 'IMAP is off for this account. Turn it on in Gmail → Settings → Forwarding and POP/IMAP.'
  if (code === 'AUTHENTICATIONFAILED' || /invalid credentials|authenticat/i.test(msg))
    return 'Gmail rejected the app password. Check the address, or create a new app password at https://myaccount.google.com/apppasswords.'
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|timed out/i.test(msg + code))
    return `Can't reach Gmail (${code || msg}). Are you offline?`
  return `Gmail check failed: ${msg}`
}

function isAuthError(err) {
  const msg = String(err?.imapText || err?.message || '')
  return err?.code === 'AUTHENTICATIONFAILED' || /password|credentials|web ?login|WEBALERT|not enabled for IMAP/i.test(msg)
}

/** @returns {SourceItem | null} */
function toItem(attrs, email) {
  const body = fetchBody(attrs)
  if (!body) return null
  const msg = parseMessage(body)
  const msgId = attrs['X-GM-MSGID'] != null ? String(attrs['X-GM-MSGID']) : `uid-${attrs.UID}`
  let url
  try {
    if (attrs['X-GM-THRID'] != null)
      url = `https://mail.google.com/mail/u/${encodeURIComponent(email)}/#all/${BigInt(String(attrs['X-GM-THRID'])).toString(16)}`
  } catch {}
  let receivedAt = parseInternalDate(attrs.INTERNALDATE)
  if (!Number.isFinite(receivedAt)) receivedAt = Date.parse(msg.date)
  if (!Number.isFinite(receivedAt)) receivedAt = Date.now()
  const text = cleanText(msg.text, MAX_TEXT)
  return {
    id: msgId,
    from: msg.from?.address || 'unknown',
    fromName: msg.from?.name || undefined,
    subject: msg.subject || undefined,
    text: text || (msg.subject ? '(no text)' : '(empty message)'),
    receivedAt,
    url,
    where: 'Inbox'
  }
}

/**
 * The poller, separate from activate() so tests can drive it with a fake server.
 * @param {PluginContext} ctx
 * @param {{ connect?: Function, host?: string, port?: number, timeoutMs?: number }} [opts]
 */
function createWatcher(ctx, opts = {}) {
  const email = String(ctx.settings.email || '').trim().toLowerCase()
  const password = String(ctx.settings.appPassword || '').replace(/\s+/g, '') // Google shows it as "abcd efgh ijkl mnop"
  const query = buildQuery({ skipCategories: ctx.settings.skipCategories !== false, onlyImportant: ctx.settings.onlyImportant === true })
  let client = null
  let busy = false

  function open() {
    if (!email || !password) throw new Error('Add your Gmail address and app password in Settings.')
    client = new ImapClient({ host: opts.host, port: opts.port, connect: opts.connect, timeoutMs: opts.timeoutMs })
    return client
  }

  async function close(c) {
    if (!c) return
    await c.logout().catch(() => {})
    if (client === c) client = null
  }

  /** One check: connect, look for new UIDs, emit, log out. Returns the number of items emitted. */
  async function poll() {
    if (busy) return 0
    busy = true
    let c = null
    try {
      c = open()
      await c.connect()
      await c.login(email, password)
      const box = await c.examine('INBOX')
      let uidNext = box.uidNext
      if (!uidNext) {
        // Every server we care about sends UIDNEXT, but just in case: ask for the highest UID.
        const top = box.exists ? await c.uidFetch('*', '(UID)') : []
        uidNext = (top.length ? Math.max(...top.map((a) => Number(a.UID) || 0)) : 0) + 1
      }
      const cursor = ctx.storage.get(CURSOR_KEY)
      if (!cursor || cursor.email !== email || cursor.uidValidity !== box.uidValidity) {
        // First run (or the mailbox was rebuilt): start from now, don't replay the backlog.
        ctx.storage.set(CURSOR_KEY, { email, uidValidity: box.uidValidity, lastUid: uidNext - 1, since: Date.now() })
        ctx.log.info(`Baseline set at UID ${uidNext - 1} (UIDVALIDITY ${box.uidValidity})`)
        return 0
      }
      let emitted = 0
      let lastUid = cursor.lastUid
      if (uidNext - 1 > cursor.lastUid) {
        // "n:*" always includes the highest UID even if it is below n, so filter client-side.
        const found = await c.uidSearch(`UID ${cursor.lastUid + 1}:* X-GM-RAW ${quote(query)}`)
        const uids = [...new Set(found)].filter((u) => u > cursor.lastUid).sort((a, b) => a - b)
        const take = uids.slice(-MAX_PER_POLL)
        if (uids.length > take.length) ctx.log.warn(`${uids.length} new messages; only checking the newest ${take.length}`)
        if (take.length) {
          const rows = await c.uidFetch(take.join(','), FETCH_ITEMS)
          const floor = (cursor.since || 0) - 24 * 3600_000 // ignore old mail that was moved back into the inbox
          const items = []
          for (const attrs of rows.sort((a, b) => Number(a.UID) - Number(b.UID))) {
            try {
              const item = toItem(attrs, email)
              if (item && item.receivedAt >= floor) items.push(item)
            } catch (err) {
              ctx.log.warn(`Could not read message UID ${attrs.UID}: ${err?.message || err}`)
            }
          }
          if (items.length) ctx.source.emit(items)
          emitted = items.length
        }
        lastUid = Math.max(cursor.lastUid, uidNext - 1, ...uids)
      }
      ctx.storage.set(CURSOR_KEY, { ...cursor, lastUid })
      return emitted
    } finally {
      busy = false
      await close(c)
    }
  }

  async function test() {
    let c = null
    try {
      c = open()
      await c.connect()
      await c.login(email, password)
      await c.examine('INBOX')
    } catch (err) {
      throw new Error(friendlyError(err))
    } finally {
      await close(c)
    }
    return `Connected as ${email}. Watching for new mail.`
  }

  function stop() {
    try {
      client?.destroy()
    } catch {}
    client = null
  }

  return { poll, test, stop, email, query }
}

/** @param {PluginContext} ctx */
async function activate(ctx) {
  const watcher = createWatcher(ctx)
  const intervalMs = Math.max(1, Number(ctx.settings.pollMinutes) || 2) * 60_000
  const state = { stopped: false, timer: null, failures: 0, watcher }
  current = state

  ctx.source.register({ test: () => watcher.test(), stop: () => halt(state) })

  if (!watcher.email || !String(ctx.settings.appPassword || '').trim()) {
    ctx.setStatus('error', 'Add your Gmail address and app password, then Save.')
    return
  }

  const schedule = (ms) => {
    if (state.stopped) return
    clearTimeout(state.timer)
    state.timer = setTimeout(tick, ms)
  }

  async function tick() {
    if (state.stopped) return
    try {
      const n = await watcher.poll()
      if (state.stopped) return
      if (n) ctx.log.info(`Handed ${n} new message${n === 1 ? '' : 's'} to Hive`)
      state.failures = 0
      ctx.setStatus('running', `Watching ${watcher.email} · checked ${hhmm()}`)
      schedule(intervalMs)
    } catch (err) {
      if (state.stopped) return
      state.failures++
      const base = isAuthError(err) ? Math.max(AUTH_BACKOFF_MS, intervalMs) : intervalMs
      const delay = Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(state.failures - 1, 5))
      const msg = friendlyError(err)
      ctx.log.error(`Poll failed (${state.failures}): ${err?.message || err}`)
      ctx.setStatus('error', `${msg} Retrying in ${Math.round(delay / 60_000)} min.`)
      schedule(delay)
    }
  }

  ctx.setStatus('running', `Connecting to ${watcher.email}…`)
  schedule(1000)
}

function halt(state) {
  if (!state) return
  state.stopped = true
  clearTimeout(state.timer)
  state.watcher.stop()
}

module.exports = {
  activate,
  deactivate() {
    halt(current)
    current = null
  },
  // For tests.
  _internals: { createWatcher, buildQuery, parseInternalDate, friendlyError, toItem }
}
