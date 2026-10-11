import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

// The plugin is plain CommonJS with no types; load it at runtime.
const req = createRequire(import.meta.url)
const mime = req('../../../../../plugins/source-gmail/mime.js')
const imap = req('../../../../../plugins/source-gmail/imap.js')
const plugin = req('../../../../../plugins/source-gmail/index.js')

const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n')

describe('gmail mime', () => {
  it('decodes RFC 2047 headers and addresses', () => {
    expect(mime.decodeWords('=?UTF-8?B?w4lsw6huZQ==?= Dupont')).toBe('Élène Dupont')
    expect(mime.decodeWords('=?iso-8859-1?Q?Caf=E9_cr=E8me?=')).toBe('Café crème')
    // Adjacent encoded words are joined, even when a multibyte char is split between them.
    expect(mime.decodeWords('=?utf-8?B?4oKs?= =?utf-8?B?IDEw?=')).toBe('€ 10')
    expect(mime.decodeWords('Re: =?utf-8?Q?h=C3=A9llo?= world')).toBe('Re: héllo world')

    expect(mime.parseAddress('"Doe, Jane" <Jane.Doe@Example.com>')).toEqual({ name: 'Doe, Jane', address: 'jane.doe@example.com' })
    expect(mime.parseAddress('=?utf-8?Q?Ren=C3=A9e?= <renee@x.fr>')).toEqual({ name: 'Renée', address: 'renee@x.fr' })
    expect(mime.parseAddress('bob@x.com (Bob B)')).toEqual({ name: 'Bob B', address: 'bob@x.com' })
    expect(mime.parseAddress('plain@x.com')).toEqual({ name: '', address: 'plain@x.com' })

    const msg = mime.parseMessage(
      crlf('From: =?utf-8?B?5bGx55Sw?= <yamada@example.jp>\nSubject: =?utf-8?B?5Lya6K2w?=\n =?utf-8?B?44Gu5Lu2?=\n\nhi\n')
    )
    expect(msg.from).toEqual({ name: '山田', address: 'yamada@example.jp' })
    expect(msg.subject).toBe('会議の件')
    expect(msg.text.trim()).toBe('hi')
  })

  it('prefers text/plain in multipart/alternative with QP and base64 parts', () => {
    const html = Buffer.from('<p>HTML version</p>').toString('base64')
    const raw = crlf(`From: a@b.com
Subject: Lunch
Content-Type: multipart/mixed; boundary="outer"

preamble
--outer
Content-Type: multipart/alternative; boundary=inner

--inner
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Caf=C3=A9 at noon? This is a long line that has been wrapped by quoted-printa=
ble encoding.

On Mon, Oct 5, 2026 at 9:00 AM Bob <bob@x.com> wrote:
> earlier message
> more

--=20
Alice
Very long signature
--inner
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: base64

${html}
--inner--
--outer
Content-Type: application/pdf; name=x.pdf
Content-Disposition: attachment; filename=x.pdf
Content-Transfer-Encoding: base64

JVBERi0xLjQK
--outer--
`)
    const msg = mime.parseMessage(Buffer.from(raw, 'latin1'))
    expect(msg.plain).toContain('Café at noon?')
    expect(msg.plain).toContain('quoted-printable encoding.')
    expect(msg.html).toBe('<p>HTML version</p>')
    expect(mime.cleanText(msg.text)).toBe('Café at noon? This is a long line that has been wrapped by quoted-printable encoding.')
  })

  it('converts html-only mail to text and drops quoted blockquotes', () => {
    const raw = crlf(`From: News <news@x.com>
Subject: Hi
Content-Type: text/html; charset="utf-8"

<html><head><style>p{color:red}</style><title>T</title></head><body>
<script>alert(1)</script>
<div>Hello&nbsp;there &amp; welcome</div><p>Line&#160;two &#x2014; ok&#8217;s</p>
<ul><li>One</li><li>Two</li></ul>
<div class="gmail_quote">On Mon wrote:<blockquote>old <blockquote>older</blockquote> stuff</blockquote></div>
</body></html>
`)
    const msg = mime.parseMessage(raw)
    const text = mime.cleanText(msg.text)
    expect(text).toContain('Hello there & welcome')
    expect(text).toContain('Line two — ok’s')
    expect(text).toContain('• One\n• Two')
    expect(text).not.toMatch(/color|alert|old|older|stuff/)
    expect(text).not.toContain('<')
  })

  it('survives a message truncated mid-part', () => {
    const body = Buffer.from('Ünïcödé text that goes on and on '.repeat(20)).toString('base64')
    const raw = crlf(`From: x@y.com
Subject: Big
Content-Type: multipart/mixed; boundary=b1

--b1
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: base64

${body.match(/.{1,76}/g)!.join('\n')}
--b1
Content-Type: image/png
Content-Transfer-Encoding: base64

iVBORw0KGgo`)
    // Cut inside the base64 text part.
    const cut = raw.slice(0, raw.lastIndexOf('--b1') - 37)
    const msg = mime.parseMessage(cut)
    expect(msg.subject).toBe('Big')
    expect(msg.text.startsWith('Ünïcödé text that goes on')).toBe(true)
    expect(mime.cleanText(msg.text)).not.toContain('\ufffd')
    // Headers only (cut before the body) still parses.
    expect(mime.parseMessage('From: a@b.com\r\nSubject: Only head').subject).toBe('Only head')
  })

  it('decodes non-UTF-8 charsets', () => {
    const raw = Buffer.concat([
      Buffer.from(crlf('From: a@b.de\nSubject: =?windows-1252?Q?Gr=FC=DFe?=\nContent-Type: text/plain; charset=ISO-8859-1\nContent-Transfer-Encoding: 8bit\n\n'), 'latin1'),
      Buffer.from([0x53, 0x63, 0x68, 0xf6, 0x6e, 0x65, 0x20, 0x47, 0x72, 0xfc, 0xdf, 0x65]) // "Schöne Grüße" in latin1
    ])
    const msg = mime.parseMessage(raw)
    expect(msg.subject).toBe('Grüße')
    expect(msg.text).toBe('Schöne Grüße')
    // Unknown charset falls back to UTF-8.
    expect(mime.decodeBytes(Buffer.from('héllo'), 'x-made-up')).toBe('héllo')
  })

  it('trims signatures, Outlook reply headers and collapses whitespace', () => {
    const t = mime.cleanText('Hi   there,\n\n\n\nCan you   review?\n\nSent from my iPhone\n\nFrom: Bob\nSent: Monday\nTo: Al\nold text')
    expect(t).toBe('Hi there,\n\nCan you review?')
    expect(mime.cleanText('x'.repeat(5000)).length).toBe(3500)
  })
})

describe('gmail imap parsing', () => {
  it('parses FETCH responses with literals, quoted escapes and nested lists', () => {
    const body = 'Subject: Hi\r\n\r\nline1\r\nline2 ) ( "\r\n'
    const raw = Buffer.from(
      `* 12 FETCH (UID 345 X-GM-MSGID 1766584011422318461 X-GM-THRID 1766584011422318461 ` +
        `X-GM-LABELS ("\\\\Important" "\\\\Inbox" {5}\r\nCafé Work) INTERNALDATE "10-Oct-2026 09:15:00 +0200" ` +
        `FLAGS (\\Seen) BODY[]<0> {${Buffer.byteLength(body)}}\r\n${body} BODY[HEADER.FIELDS (FROM TO)] NIL)\r\n`
    )
    const f = imap.parseFetch(raw)
    expect(f.seq).toBe(12)
    expect(f.attrs.UID).toBe('345')
    expect(f.attrs['X-GM-MSGID']).toBe('1766584011422318461')
    expect(f.attrs['X-GM-LABELS'][0]).toBe('\\Important')
    expect(Buffer.isBuffer(f.attrs['X-GM-LABELS'][2])).toBe(true)
    expect(f.attrs['X-GM-LABELS'][2].toString('utf8')).toBe('Café')
    expect(f.attrs['X-GM-LABELS'][3]).toBe('Work')
    expect(f.attrs.INTERNALDATE).toBe('10-Oct-2026 09:15:00 +0200')
    expect(f.attrs.FLAGS).toEqual(['\\Seen'])
    expect(imap.fetchBody(f.attrs).toString()).toBe(body)
    expect(f.attrs['BODY[HEADER.FIELDS (FROM TO)]']).toBeNull()
    expect(plugin._internals.parseInternalDate(f.attrs.INTERNALDATE)).toBe(Date.UTC(2026, 9, 10, 7, 15, 0))
  })

  it('reassembles responses split across arbitrary chunks', async () => {
    const sock = Object.assign(new EventEmitter(), {
      written: [] as string[],
      write(s: string) {
        this.written.push(s)
      },
      destroy() {}
    })
    const client = new imap.ImapClient({ connect: () => sock })
    const connected = client.connect()
    sock.emit('data', Buffer.from('* OK hi\r\n'))
    await connected
    const p = client.uidFetch('7', '(UID BODY.PEEK[])')
    const lit = 'a\r\nb\r\n{3}\r\n' // literal containing CRLF and a fake literal marker
    const wire = Buffer.from(`* 1 FETCH (UID 7 BODY[] {${lit.length}}\r\n${lit})\r\n${'H1'} OK done\r\n`)
    for (const b of wire) sock.emit('data', Buffer.from([b]))
    const rows = await p
    expect(sock.written[0]).toBe('H1 UID FETCH 7 (UID BODY.PEEK[])\r\n')
    expect(rows).toHaveLength(1)
    expect(rows[0]['BODY[]'].toString()).toBe(lit)
  })
})

// ---------------------------------------------------------------------------
// End-to-end against a fake Gmail IMAP server over plain TCP.

interface FakeMsg {
  uid: number
  raw: string
}

function imapDate(ms: number) {
  const d = new Date(ms)
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())}-${mon}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`
}

function fakeGmail(opts: { password: string }) {
  const state = { uidValidity: 7, uidNext: 11, messages: [] as FakeMsg[], commands: [] as string[] }
  const server = net.createServer((sock) => {
    sock.write('* OK Gimap ready\r\n')
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString('latin1')
      let i
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        state.commands.push(line)
        const [tag, cmd, ...rest] = line.split(' ')
        const C = cmd.toUpperCase()
        if (C === 'LOGIN') {
          if (rest[1] === `"${opts.password}"`) sock.write(`${tag} OK you@gmail.com authenticated (Success)\r\n`)
          else sock.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`)
        } else if (C === 'EXAMINE') {
          sock.write(
            `* FLAGS (\\Answered \\Seen)\r\n* OK [UIDVALIDITY ${state.uidValidity}] UIDs valid.\r\n` +
              `* ${state.messages.length + 10} EXISTS\r\n* 0 RECENT\r\n* OK [UIDNEXT ${state.uidNext}] Predicted next UID.\r\n` +
              `${tag} OK [READ-ONLY] INBOX selected. (Success)\r\n`
          )
        } else if (C === 'UID' && rest[0].toUpperCase() === 'SEARCH') {
          const from = Number(/UID (\d+):\*/.exec(line)![1])
          // Like Gmail, "n:*" also returns the highest existing UID (10) when nothing is >= n.
          const uids = state.messages.filter((m) => m.uid >= from).map((m) => m.uid)
          sock.write(`* SEARCH ${[10, ...uids].join(' ')}\r\n${tag} OK SEARCH completed (Success)\r\n`)
        } else if (C === 'UID' && rest[0].toUpperCase() === 'FETCH') {
          const want = rest[1].split(',').map(Number)
          let out = ''
          for (const m of state.messages.filter((x) => want.includes(x.uid))) {
            const len = Buffer.byteLength(m.raw, 'latin1')
            out +=
              `* ${m.uid - 10} FETCH (X-GM-THRID 1766584011422318461 X-GM-MSGID ${9000 + m.uid} UID ${m.uid} ` +
              `X-GM-LABELS ("\\\\Inbox") INTERNALDATE "${imapDate(Date.now())}" BODY[]<0> {${len}}\r\n${m.raw})\r\n`
          }
          // Send in two writes split inside a literal to exercise the reader.
          const half = Math.floor(out.length / 2)
          sock.write(Buffer.from(out.slice(0, half), 'latin1'))
          setTimeout(() => sock.write(Buffer.from(out.slice(half) + `${tag} OK Success\r\n`, 'latin1')), 5)
        } else if (C === 'LOGOUT') {
          sock.write(`* BYE LOGOUT Requested\r\n${tag} OK 73 good day (Success)\r\n`)
          sock.end()
        } else {
          sock.write(`${tag} BAD Unknown command\r\n`)
        }
      }
    })
    sock.on('error', () => {})
  })
  return { server, state }
}

function fakeCtx(settings: Record<string, unknown>) {
  const store = new Map<string, unknown>()
  const emitted: any[][] = []
  const statuses: [string, string?][] = []
  const ctx = {
    hiveApi: 1,
    settings,
    dataDir: '',
    log: { info() {}, warn() {}, error() {} },
    storage: { get: (k: string) => store.get(k), set: (k: string, v: unknown) => void store.set(k, JSON.parse(JSON.stringify(v))) },
    setStatus: (s: string, m?: string) => void statuses.push([s, m]),
    channel: { register() {}, reply() {} },
    source: { register() {}, emit: (items: any[]) => void emitted.push(items) }
  }
  return { ctx, store, emitted, statuses }
}

describe('gmail source end-to-end (fake IMAP server)', () => {
  let server: net.Server | null = null
  afterEach(() => {
    server?.close()
    server = null
  })

  async function start() {
    const fake = fakeGmail({ password: 'abcdefghijklmnop' })
    server = fake.server
    await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r))
    const port = (fake.server.address() as net.AddressInfo).port
    const connect = () => net.connect(port, '127.0.0.1')
    return { ...fake, connect }
  }

  it('baselines on first poll, then emits only new mail with the X-GM-RAW query', async () => {
    const { state, connect } = await start()
    const { ctx, store, emitted } = fakeCtx({ email: 'You@Gmail.com', appPassword: 'abcd efgh ijkl mnop', pollMinutes: 2 })
    const w = plugin._internals.createWatcher(ctx, { connect })

    // First poll: no emit, cursor at UIDNEXT-1, no SEARCH issued.
    expect(await w.poll()).toBe(0)
    expect(store.get('cursor')).toMatchObject({ email: 'you@gmail.com', uidValidity: 7, lastUid: 10 })
    expect(state.commands.some((c) => / EXAMINE "INBOX"/.test(c))).toBe(true)
    expect(state.commands.some((c) => /SEARCH/.test(c))).toBe(false)
    expect(state.commands.find((c) => /LOGIN/.test(c))).toContain('"abcdefghijklmnop"')

    // Nothing new: the stale "10" from n:* must not be emitted.
    state.commands = []
    expect(await w.poll()).toBe(0)
    expect(emitted).toHaveLength(0)

    // Two new messages arrive.
    state.messages.push(
      {
        uid: 11,
        raw: crlf(
          'From: "Jane Boss" <Jane@Acme.com>\nSubject: =?utf-8?Q?Urgent=3A_contract_=E2=9C=8D?=\nContent-Type: text/plain; charset=utf-8\n\nPlease sign today.\n\n> old quote\n'
        )
      },
      {
        uid: 12,
        raw: crlf('From: news@shop.com\nSubject: Sale\nContent-Type: text/html\n\n<p>50% &amp; more</p>')
      }
    )
    state.uidNext = 13
    state.commands = []
    expect(await w.poll()).toBe(2)
    const search = state.commands.find((c) => / UID SEARCH /.test(c))!
    expect(search).toMatch(/UID SEARCH UID 11:\* X-GM-RAW "in:inbox -category:promotions -category:social -category:forums"$/)
    expect(state.commands.find((c) => / UID FETCH /.test(c))).toMatch(
      /UID FETCH 11,12 \(UID X-GM-MSGID X-GM-THRID X-GM-LABELS INTERNALDATE BODY\.PEEK\[\]<0\.65536>\)$/
    )
    expect(state.commands.at(-1)).toMatch(/ LOGOUT$/)
    expect(emitted).toHaveLength(1)
    const [a, b] = emitted[0]
    expect(a).toMatchObject({
      id: '9011',
      from: 'jane@acme.com',
      fromName: 'Jane Boss',
      subject: 'Urgent: contract ✍',
      text: 'Please sign today.',
      where: 'Inbox',
      url: 'https://mail.google.com/mail/u/you%40gmail.com/#all/' + BigInt('1766584011422318461').toString(16)
    })
    expect(Math.abs(a.receivedAt - Date.now())).toBeLessThan(5000)
    expect(b).toMatchObject({ id: '9012', from: 'news@shop.com', text: '50% & more' })
    expect(store.get('cursor')).toMatchObject({ lastUid: 12 })

    // Nothing new again.
    state.commands = []
    expect(await w.poll()).toBe(0)
    expect(emitted).toHaveLength(1)

    // UIDVALIDITY change re-baselines instead of replaying.
    state.uidValidity = 8
    state.uidNext = 50
    expect(await w.poll()).toBe(0)
    expect(store.get('cursor')).toMatchObject({ uidValidity: 8, lastUid: 49 })
  })

  it('caps a burst at the newest 25 and uses is:important when asked', async () => {
    const { state, connect } = await start()
    const { ctx, store, emitted } = fakeCtx({ email: 'you@gmail.com', appPassword: 'abcdefghijklmnop', skipCategories: false, onlyImportant: true })
    const w = plugin._internals.createWatcher(ctx, { connect })
    await w.poll()
    for (let uid = 11; uid <= 40; uid++) state.messages.push({ uid, raw: crlf(`From: p${uid}@x.com\nSubject: n${uid}\n\nbody ${uid}`) })
    state.uidNext = 41
    expect(await w.poll()).toBe(25)
    expect(state.commands.find((c) => / UID SEARCH /.test(c))).toMatch(/X-GM-RAW "in:inbox is:important"$/)
    expect(emitted[0][0].subject).toBe('n16')
    expect(emitted[0][24].subject).toBe('n40')
    expect(store.get('cursor')).toMatchObject({ lastUid: 40 })
  })

  it('turns a rejected app password into a readable error', async () => {
    const { connect } = await start()
    const { ctx } = fakeCtx({ email: 'you@gmail.com', appPassword: 'wrong' })
    const w = plugin._internals.createWatcher(ctx, { connect })
    await expect(w.test()).rejects.toThrow(/Gmail rejected the app password/)
    await expect(w.poll()).rejects.toMatchObject({ code: 'AUTHENTICATIONFAILED' })

    const good = plugin._internals.createWatcher(fakeCtx({ email: 'you@gmail.com', appPassword: 'abcdefghijklmnop' }).ctx, { connect })
    await expect(good.test()).resolves.toBe('Connected as you@gmail.com. Watching for new mail.')
  })
})
