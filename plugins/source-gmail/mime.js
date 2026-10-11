// A tolerant MIME parser for (possibly truncated) email messages. Extracts headers and a readable text body.
// Works on "binary strings" (latin1, one char per byte) until a charset is known, then decodes with TextDecoder.

const MAX_DEPTH = 12

// ---------------------------------------------------------------------------
// Charsets

const LATIN1_LABELS = new Set(['iso-8859-1', 'latin1', 'l1', 'us-ascii', 'ascii', 'windows-1252', 'cp1252'])

function normCharset(cs) {
  cs = String(cs || '').trim().replace(/^["']|["']$/g, '').toLowerCase()
  const star = cs.indexOf('*') // RFC 2231 language suffix: utf-8*en
  if (star > 0) cs = cs.slice(0, star)
  if (!cs || cs === 'unknown-8bit' || cs === 'x-unknown' || cs === 'default' || cs === 'utf8') return 'utf-8'
  return cs
}

/** Decode bytes in the given charset, falling back to UTF-8. */
function decodeBytes(bytes, charset) {
  const cs = normCharset(charset)
  try {
    return new TextDecoder(cs).decode(bytes)
  } catch {
    // Unknown label, or a Node built without full ICU.
    if (LATIN1_LABELS.has(cs)) return Buffer.from(bytes).toString('latin1')
    return new TextDecoder('utf-8').decode(bytes)
  }
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true })

/** Raw header bytes: UTF-8 if valid (RFC 6532), else latin1. */
function binToStr(bin) {
  if (!/[\x80-\xff]/.test(bin)) return bin
  try {
    return utf8Strict.decode(Buffer.from(bin, 'latin1'))
  } catch {
    return bin
  }
}

// ---------------------------------------------------------------------------
// Transfer encodings (input and output are binary strings / Buffers)

function decodeBase64(bin) {
  let s = bin.replace(/[^A-Za-z0-9+/]/g, '')
  if (s.length % 4 === 1) s = s.slice(0, -1) // truncated mid-group
  return Buffer.from(s, 'base64')
}

function decodeQP(bin) {
  const s = bin.replace(/=[ \t]*\r?\n/g, '')
  const out = Buffer.alloc(s.length)
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0x3d /* = */) {
      const hex = s.slice(i + 1, i + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out[n++] = parseInt(hex, 16)
        i += 2
        continue
      }
      if (i + 1 >= s.length) break // truncated at a lone "="
    }
    out[n++] = c & 0xff
  }
  return out.subarray(0, n)
}

function decodeTransfer(bin, cte) {
  cte = String(cte || '').trim().toLowerCase()
  if (cte === 'base64') return decodeBase64(bin)
  if (cte === 'quoted-printable') return decodeQP(bin)
  return Buffer.from(bin, 'latin1')
}

// ---------------------------------------------------------------------------
// Headers

/** RFC 2047 encoded words: =?charset?B|Q?text?= . Adjacent words are joined (whitespace between them dropped). */
function decodeWords(str) {
  str = String(str ?? '')
  if (!str.includes('=?')) return str
  const re = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g
  let out = ''
  let last = 0
  let run = null // { charset, chunks: Buffer[] }
  const flush = () => {
    if (run) out += decodeBytes(Buffer.concat(run.chunks), run.charset)
    run = null
  }
  let m
  while ((m = re.exec(str))) {
    const between = str.slice(last, m.index)
    if (!(run && /^\s*$/.test(between))) {
      flush()
      out += between
    }
    const charset = normCharset(m[1])
    const bytes =
      m[2].toUpperCase() === 'B' ? decodeBase64(m[3]) : decodeQP(m[3].replace(/_/g, ' ').replace(/=\r?\n/g, ''))
    if (run && run.charset !== charset) flush()
    if (!run) run = { charset, chunks: [] }
    run.chunks.push(bytes)
    last = m.index + m[0].length
  }
  flush()
  return out + str.slice(last)
}

/** Parse a header block (binary string) into [{ name, value }], value unfolded and charset-decoded but not RFC 2047 decoded. */
function parseHeaders(bin) {
  const out = []
  const unfolded = bin.replace(/\r?\n(?=[ \t])/g, '')
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const name = line.slice(0, i).trim().toLowerCase()
    if (!name || /\s/.test(name)) continue
    out.push({ name, value: binToStr(line.slice(i + 1).trim()) })
  }
  return out
}

function headerGetter(list) {
  return (name) => {
    const h = list.find((x) => x.name === name)
    return h ? h.value : undefined
  }
}

/** "text/plain; charset=utf-8; format=flowed" -> { value: 'text/plain', params: { charset: 'utf-8', ... } } */
function parseParams(v) {
  const parts = []
  let cur = ''
  let q = false
  for (let i = 0; i < String(v || '').length; i++) {
    const c = v[i]
    if (c === '\\' && q) {
      cur += v[++i] ?? ''
      continue
    }
    if (c === '"') q = !q
    if (c === ';' && !q) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  parts.push(cur)
  const value = parts.shift().trim().toLowerCase()
  const params = {}
  for (const p of parts) {
    const i = p.indexOf('=')
    if (i < 0) continue
    let key = p.slice(0, i).trim().toLowerCase()
    let val = p.slice(i + 1).trim().replace(/^"(.*)"$/s, '$1')
    if (key.endsWith('*')) {
      // RFC 2231: charset'lang'%XX..
      key = key.slice(0, -1)
      const m = /^([^']*)'[^']*'(.*)$/.exec(val)
      if (m) val = decodeBytes(Buffer.from(m[2].replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1'), m[1])
    }
    if (!(key in params)) params[key] = val
  }
  return { value, params }
}

/**
 * First mailbox in an address header: `"Jane Doe" <jane@x.com>`, `jane@x.com (Jane)`, `=?utf-8?..?= <a@b>`.
 * @returns {{ name: string, address: string } | null}
 */
function parseAddress(v) {
  v = String(v || '').trim()
  if (!v) return null
  const unq = (s) =>
    decodeWords(
      s
        .trim()
        .replace(/^"(.*)"$/s, '$1')
        .replace(/\\(.)/g, '$1')
        .trim()
    )
  const angle = /^((?:"(?:[^"\\]|\\.)*"|[^<"])*)<\s*([^<>\s]+)\s*>/.exec(v)
  if (angle && angle[2].includes('@')) return { name: unq(angle[1]), address: angle[2].toLowerCase() }
  const bare = /[^\s<>"(),;:]+@[^\s<>"(),;:]+/.exec(v)
  if (!bare) return null
  const comment = /\(([^)]*)\)/.exec(v)
  return { name: comment ? unq(comment[1]) : '', address: bare[0].replace(/\.$/, '').toLowerCase() }
}

// ---------------------------------------------------------------------------
// HTML to text

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', times: '×',
  shy: '', zwnj: '', zwj: '', thinsp: ' ', ensp: ' ', emsp: ' ', rarr: '→', larr: '←', hearts: '♥',
  eacute: 'é', egrave: 'è', ecirc: 'ê', aacute: 'á', agrave: 'à', acirc: 'â', iacute: 'í', oacute: 'ó',
  uacute: 'ú', ntilde: 'ñ', ccedil: 'ç', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß'
}

function decodeEntities(s) {
  return s.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);?/g, (all, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      try {
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
      } catch {
        return ''
      }
    }
    if (Object.prototype.hasOwnProperty.call(ENTITIES, e)) return ENTITIES[e]
    const lower = e.toLowerCase()
    if (Object.prototype.hasOwnProperty.call(ENTITIES, lower)) return ENTITIES[lower]
    return all
  })
}

const QUOTE_OPEN = '\u0001'
const QUOTE_CLOSE = '\u0002'

function htmlToText(html) {
  let s = String(html || '')
  s = s.replace(/<!--[\s\S]*?(-->|$)/g, '')
  s = s.replace(/<(head|style|script|title|noscript|template)\b[\s\S]*?(<\/\1\s*>|$)/gi, '')
  s = s.replace(/<blockquote\b[^>]*>/gi, QUOTE_OPEN).replace(/<\/blockquote\s*>/gi, QUOTE_CLOSE)
  s = s.replace(/<br\b[^>]*>/gi, '\n')
  s = s.replace(/<li\b[^>]*>/gi, '\n• ')
  s = s.replace(/<\/?(p|div|tr|table|tbody|thead|ul|ol|h[1-6]|hr|section|article|header|footer|pre|center|dl|dt|dd|address|form|fieldset|figure|main|nav|aside)\b[^>]*>/gi, '\n')
  s = s.replace(/<\/(td|th)\s*>/gi, ' ')
  s = s.replace(/<[^>]*>/g, '')
  s = s.replace(/<[^>]*$/, '') // truncated tag at the end
  s = decodeEntities(s)
  // Drop quoted replies (Gmail/Apple put them in <blockquote>).
  let out = ''
  let depth = 0
  for (const ch of s) {
    if (ch === QUOTE_OPEN) depth++
    else if (ch === QUOTE_CLOSE) depth = Math.max(0, depth - 1)
    else if (depth === 0) out += ch
  }
  return out
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------------------------------------------------------------------------
// Body cleanup: quoted replies, signatures, whitespace.

function clip(s, n) {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s
}

function cleanText(text, max = 3500) {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[​-‍⁠﻿͏­�]/g, '')
    .replace(/ /g, ' ')
    .split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const t = raw.trim()
    if (t.startsWith('>')) continue
    if (raw === '-- ' || t === '--') break // signature delimiter
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(t)) break
    // Outlook reply header: From: … / Sent: …
    if (out.length && /^From:\s/.test(t) && lines.slice(i + 1, i + 5).some((l) => /^\s*Sent:\s/.test(l))) break
    // "On Mon, 1 Jan 2026 at 10:00, Jane <jane@x.com> wrote:" (sometimes wrapped onto two lines)
    if (/^On\b.{0,300}\bwrote:$/i.test(t)) continue
    if (/^On\b/i.test(t) && i + 1 < lines.length && /^.{0,200}\bwrote:$/i.test(lines[i + 1].trim()) && /^>|^$/.test((lines[i + 2] || '').trim())) {
      i++
      continue
    }
    if (/^(Sent from my \w+|Sent from (Mail|Outlook) for|Get Outlook for (iOS|Android))/i.test(t)) continue
    out.push(t.replace(/[ \t]+/g, ' '))
  }
  while (out.length && /^([-_=*]{3,})?$/.test(out[out.length - 1])) out.pop()
  const s = out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return clip(s, max)
}

// ---------------------------------------------------------------------------
// Message structure

function splitHeadBody(bin) {
  const m = /\r?\n\r?\n/.exec(bin)
  if (!m) return [bin, '']
  return [bin.slice(0, m.index), bin.slice(m.index + m[0].length)]
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function splitMultipart(body, boundary) {
  const re = new RegExp('(?:^|\\r?\\n)--' + escapeRe(boundary) + '(--)?[ \\t]*(?=\\r?\\n|$)', 'g')
  const parts = []
  let start = -1
  let m
  while ((m = re.exec(body))) {
    if (start >= 0) parts.push(body.slice(start, m.index))
    if (m[1]) return parts // closing delimiter
    start = m.index + m[0].length
    const nl = /^\r?\n/.exec(body.slice(start, start + 2))
    if (nl) start += nl[0].length
  }
  if (start >= 0 && start < body.length) parts.push(body.slice(start)) // truncated: keep the partial last part
  return parts
}

function walk(bin, acc, depth, defaultType = 'text/plain') {
  if (depth > MAX_DEPTH) return
  const [head, body] = splitHeadBody(bin)
  const headers = parseHeaders(head)
  const get = headerGetter(headers)
  const ct = parseParams(get('content-type') || defaultType)
  const disp = parseParams(get('content-disposition') || '')
  if (disp.value === 'attachment') return
  if (ct.value.startsWith('multipart/')) {
    const boundary = ct.params.boundary
    if (!boundary) return
    const sub = ct.value === 'multipart/digest' ? 'message/rfc822' : 'text/plain'
    for (const part of splitMultipart(body, boundary)) walk(part, acc, depth + 1, sub)
    return
  }
  if (ct.value === 'message/rfc822') {
    walk(decodeTransfer(body, get('content-transfer-encoding')).toString('latin1'), acc, depth + 1)
    return
  }
  if (ct.value !== 'text/plain' && ct.value !== 'text/html') return
  const bytes = decodeTransfer(body, get('content-transfer-encoding'))
  const text = decodeBytes(bytes, ct.params.charset)
  if (ct.value === 'text/plain' && acc.plain == null) acc.plain = text
  if (ct.value === 'text/html' && acc.html == null) acc.html = text
}

/**
 * Parse a raw message (Buffer, Uint8Array or binary string).
 * @returns {{ from: {name: string, address: string} | null, subject: string, date: string, messageId: string,
 *             plain: string | null, html: string | null, text: string, header(name: string): string | undefined }}
 */
function parseMessage(raw) {
  const bin = typeof raw === 'string' ? raw : Buffer.from(raw).toString('latin1')
  const [head] = splitHeadBody(bin)
  const headers = parseHeaders(head)
  const get = headerGetter(headers)
  const acc = { plain: null, html: null }
  walk(bin, acc, 0)
  let text = acc.plain && acc.plain.trim() ? acc.plain : ''
  if (!text && acc.html) text = htmlToText(acc.html)
  return {
    from: parseAddress(get('from')),
    subject: decodeWords(get('subject') || '').replace(/\s+/g, ' ').trim(),
    date: get('date') || '',
    messageId: get('message-id') || '',
    plain: acc.plain,
    html: acc.html,
    text,
    header: (name) => {
      const v = get(String(name).toLowerCase())
      return v == null ? v : decodeWords(v)
    }
  }
}

module.exports = {
  parseMessage,
  parseHeaders,
  parseParams,
  parseAddress,
  decodeWords,
  decodeBytes,
  decodeQP,
  decodeBase64,
  htmlToText,
  decodeEntities,
  cleanText,
  splitMultipart
}
