// A small promise-based IMAP client: just enough for read-only polling of one mailbox.
// One command in flight at a time. Responses are kept as raw bytes so literals ({n}) survive intact.

const tls = require('node:tls')

const CRLF = Buffer.from('\r\n')

/** Quote a string as an IMAP quoted-string. */
function quote(s) {
  s = String(s)
  if (/[\r\n]/.test(s)) throw new Error('IMAP strings cannot contain line breaks')
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

// ---------------------------------------------------------------------------
// Tokenizer for IMAP data: atoms, NIL, quoted strings, literals, nested lists.
// Values: list -> Array, atom -> string, quoted -> string, literal -> Buffer, NIL -> null.

const SP = 0x20
const LPAREN = 0x28
const RPAREN = 0x29
const DQUOTE = 0x22
const LBRACE = 0x7b
const LBRACKET = 0x5b
const RBRACKET = 0x5d
const BACKSLASH = 0x5c
const CR = 0x0d
const LF = 0x0a

function skipSpaces(buf, pos) {
  while (pos < buf.length && (buf[pos] === SP || buf[pos] === 0x09)) pos++
  return pos
}

/** Parse one value starting at `pos`. Returns [value, nextPos]. */
function parseValue(buf, pos) {
  pos = skipSpaces(buf, pos)
  if (pos >= buf.length) throw new Error('IMAP parse: unexpected end of data')
  const c = buf[pos]
  if (c === LPAREN) {
    const list = []
    pos++
    for (;;) {
      pos = skipSpaces(buf, pos)
      if (pos >= buf.length) throw new Error('IMAP parse: unterminated list')
      if (buf[pos] === RPAREN) return [list, pos + 1]
      if (buf[pos] === CR || buf[pos] === LF) {
        pos++
        continue
      }
      const [v, next] = parseValue(buf, pos)
      list.push(v)
      pos = next
    }
  }
  if (c === DQUOTE) {
    const bytes = []
    pos++
    while (pos < buf.length) {
      const b = buf[pos]
      if (b === BACKSLASH && pos + 1 < buf.length) {
        bytes.push(buf[pos + 1])
        pos += 2
        continue
      }
      if (b === DQUOTE) return [Buffer.from(bytes).toString('utf8'), pos + 1]
      bytes.push(b)
      pos++
    }
    throw new Error('IMAP parse: unterminated quoted string')
  }
  if (c === LBRACE) {
    const close = buf.indexOf('}', pos)
    const m = close > 0 ? /^\{(\d+)\+?\}$/.exec(buf.toString('latin1', pos, close + 1)) : null
    if (m) {
      const n = Number(m[1])
      let start = close + 1
      if (buf[start] === CR) start++
      if (buf[start] === LF) start++
      const end = Math.min(start + n, buf.length)
      return [Buffer.from(buf.subarray(start, end)), end]
    }
  }
  // Atom. Brackets may contain spaces and parens: BODY[HEADER.FIELDS (FROM)]<0>
  const start = pos
  let depth = 0
  while (pos < buf.length) {
    const b = buf[pos]
    if (b === LBRACKET) depth++
    else if (b === RBRACKET) depth = Math.max(0, depth - 1)
    else if (depth === 0 && (b === SP || b === LPAREN || b === RPAREN || b === DQUOTE || b === CR || b === LF)) break
    else if (depth > 0 && (b === CR || b === LF)) break
    pos++
  }
  if (pos === start) throw new Error(`IMAP parse: unexpected character ${String.fromCharCode(c)}`)
  const atom = buf.toString('latin1', start, pos)
  return [atom.toUpperCase() === 'NIL' ? null : atom, pos]
}

/**
 * Parse an untagged FETCH response ("* 12 FETCH (UID 34 ...)").
 * Returns { seq, attrs } where attrs maps upper-cased keys to values, or null if it isn't a FETCH.
 */
function parseFetch(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'latin1')
  const head = buf.toString('latin1', 0, Math.min(buf.length, 64))
  const m = /^\* (\d+) FETCH /i.exec(head)
  if (!m) return null
  const [list] = parseValue(buf, m[0].length)
  if (!Array.isArray(list)) throw new Error('IMAP parse: FETCH data is not a list')
  const attrs = {}
  for (let i = 0; i + 1 < list.length; i += 2) {
    const key = typeof list[i] === 'string' ? list[i].toUpperCase() : String(list[i])
    attrs[key] = list[i + 1]
  }
  return { seq: Number(m[1]), attrs }
}

/** Find a BODY[...] attribute regardless of the <origin> suffix the server adds. */
function fetchBody(attrs, section = '') {
  const want = `BODY[${section.toUpperCase()}]`
  for (const k of Object.keys(attrs)) if (k === want || k.startsWith(want + '<')) return attrs[k]
  return undefined
}

// ---------------------------------------------------------------------------

class ImapError extends Error {
  constructor(message, code, text) {
    super(message)
    this.name = 'ImapError'
    this.code = code
    this.imapText = text
  }
}

class ImapClient {
  /**
   * @param {{ host?: string, port?: number, connect?: (o: {host: string, port: number}) => import('node:net').Socket,
   *           timeoutMs?: number, log?: { info(...a: unknown[]): void } }} [opts]
   */
  constructor(opts = {}) {
    this.host = opts.host || 'imap.gmail.com'
    this.port = opts.port || 993
    this.connectFn = opts.connect || ((o) => tls.connect({ host: o.host, port: o.port, servername: o.host }))
    this.timeoutMs = opts.timeoutMs || 60_000
    this.socket = null
    this.buf = Buffer.alloc(0)
    this.scan = 0
    this.tagN = 0
    this.pending = null // { tag, untagged, resolve, reject, timer }
    this.greeting = null // { resolve, reject, timer }
    this.closed = false
    this.loggingOut = false
  }

  /** Open the connection and wait for the server greeting. */
  connect() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this._fail(new Error(`Timed out connecting to ${this.host}`)), this.timeoutMs)
      this.greeting = { resolve, reject, timer }
      let sock
      try {
        sock = this.connectFn({ host: this.host, port: this.port })
      } catch (err) {
        this._fail(err)
        return
      }
      this.socket = sock
      sock.on('data', (chunk) => this._onData(chunk))
      sock.on('error', (err) => this._fail(err))
      sock.on('close', () => this._fail(new Error('Connection closed by server')))
    })
  }

  _fail(err) {
    if (this.closed) return
    this.closed = true
    if (this.greeting) {
      clearTimeout(this.greeting.timer)
      this.greeting.reject(err)
      this.greeting = null
    }
    if (this.pending) {
      clearTimeout(this.pending.timer)
      // A close during LOGOUT is expected.
      if (this.loggingOut) this.pending.resolve({ status: 'OK', text: '', untagged: this.pending.untagged })
      else this.pending.reject(err)
      this.pending = null
    }
    try {
      this.socket?.destroy()
    } catch {}
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    for (;;) {
      const i = this.buf.indexOf(CRLF, this.scan)
      if (i < 0) return
      // A line ending in {n} announces a literal of n bytes that may itself contain CRLFs.
      if (i > 0 && this.buf[i - 1] === 0x7d) {
        const m = /\{(\d+)\+?\}$/.exec(this.buf.toString('latin1', Math.max(0, i - 24), i))
        if (m) {
          this.scan = i + 2 + Number(m[1])
          if (this.scan > this.buf.length) return
          continue
        }
      }
      const resp = this.buf.subarray(0, i + 2)
      this.buf = this.buf.subarray(i + 2)
      this.scan = 0
      try {
        this._dispatch(resp)
      } catch (err) {
        this._fail(err)
        return
      }
    }
  }

  _dispatch(raw) {
    const nl = raw.indexOf(CRLF)
    const line = raw.toString('utf8', 0, nl < 0 ? raw.length : nl)
    if (this.greeting) {
      const g = this.greeting
      this.greeting = null
      clearTimeout(g.timer)
      if (/^\* (OK|PREAUTH)\b/i.test(line)) g.resolve(line)
      else g.reject(new ImapError(`Server refused the connection: ${line.replace(/^\* \w+ ?/, '')}`, 'GREETING', line))
      return
    }
    const p = this.pending
    if (line.startsWith('* ')) {
      if (p) p.untagged.push({ line, raw })
      return
    }
    if (line.startsWith('+')) return // continuation request: we never send literals
    const m = /^(\S+) (OK|NO|BAD)\b ?(.*)$/i.exec(line)
    if (!p || !m || m[1] !== p.tag) return
    this.pending = null
    clearTimeout(p.timer)
    const status = m[2].toUpperCase()
    const text = m[3]
    if (status === 'OK') {
      p.resolve({ status, text, untagged: p.untagged })
      return
    }
    const code = (/^\[([A-Z0-9-]+)/i.exec(text) || [])[1]
    // Gmail sometimes explains a failure in an untagged NO/ALERT line before the tagged reply.
    const extra = p.untagged
      .map((u) => u.line)
      .filter((l) => /^\* (NO|BAD|OK \[ALERT\])/i.test(l))
      .map((l) => l.replace(/^\* \w+ /, ''))
    const full = [text, ...extra].join(' ')
    p.reject(new ImapError(`${p.name} failed: ${full}`, code ? code.toUpperCase() : status, full))
  }

  /**
   * Send a command and wait for its tagged completion.
   * @returns {Promise<{status: string, text: string, untagged: {line: string, raw: Buffer}[]}>}
   */
  command(cmd, timeoutMs = this.timeoutMs) {
    if (this.closed || !this.socket) return Promise.reject(new Error('Not connected'))
    if (this.pending) return Promise.reject(new Error('IMAP command already in progress'))
    const tag = 'H' + ++this.tagN
    const name = cmd.split(' ')[0].toUpperCase() === 'UID' ? cmd.split(' ').slice(0, 2).join(' ').toUpperCase() : cmd.split(' ')[0].toUpperCase()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this._fail(new Error(`${name} timed out`)), timeoutMs)
      this.pending = { tag, name, untagged: [], resolve, reject, timer }
      this.socket.write(`${tag} ${cmd}\r\n`)
    })
  }

  login(user, pass) {
    return this.command(`LOGIN ${quote(user)} ${quote(pass)}`)
  }

  /** EXAMINE (read-only SELECT). Returns { exists, uidValidity, uidNext }. */
  async examine(mailbox = 'INBOX') {
    const res = await this.command(`EXAMINE ${quote(mailbox)}`)
    const out = { exists: 0, uidValidity: 0, uidNext: 0 }
    for (const { line } of res.untagged) {
      let m
      if ((m = /^\* (\d+) EXISTS/i.exec(line))) out.exists = Number(m[1])
      if ((m = /\[UIDVALIDITY (\d+)\]/i.exec(line))) out.uidValidity = Number(m[1])
      if ((m = /\[UIDNEXT (\d+)\]/i.exec(line))) out.uidNext = Number(m[1])
    }
    return out
  }

  /** UID SEARCH <criteria>. Returns the UIDs as numbers. */
  async uidSearch(criteria) {
    const res = await this.command(`UID SEARCH ${criteria}`)
    const uids = []
    for (const { line } of res.untagged) {
      const m = /^\* SEARCH\b(.*)$/i.exec(line)
      if (!m) continue
      for (const t of m[1].trim().split(/\s+/)) if (/^\d+$/.test(t)) uids.push(Number(t))
    }
    return uids
  }

  /** UID FETCH <set> <items>. Returns the parsed attribute maps. */
  async uidFetch(set, items, timeoutMs = Math.max(this.timeoutMs, 120_000)) {
    const res = await this.command(`UID FETCH ${set} ${items}`, timeoutMs)
    const out = []
    for (const u of res.untagged) {
      const f = parseFetch(u.raw)
      if (f) out.push(f.attrs)
    }
    return out
  }

  async logout() {
    if (this.closed) return
    this.loggingOut = true
    try {
      await this.command('LOGOUT', 10_000)
    } catch {}
    this.destroy()
  }

  destroy() {
    this.loggingOut = true
    this._fail(new Error('Connection closed'))
  }
}

module.exports = { ImapClient, ImapError, parseValue, parseFetch, fetchBody, quote }
