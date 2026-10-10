// Worker thread: indexes Claude Code transcripts into SQLite FTS5 and answers searches.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { parseTranscriptLine, toFtsQuery } from '@core/transcript'
import type { SearchHit } from '@shared/types'

// node:sqlite is still flagged experimental; load it lazily so a missing module only disables search.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')

const { dbPath, projectsDir } = workerData as { dbPath: string; projectsDir: string }
const port = parentPort!

const db = new DatabaseSync(dbPath)
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, size INTEGER, offset INTEGER);
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, cwd TEXT, title TEXT, first_ts TEXT, last_ts TEXT, msg_count INTEGER DEFAULT 0
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(
    text, session_id UNINDEXED, role UNINDEXED, ts UNINDEXED, tokenize = 'porter unicode61'
  );
`)

const getFile = db.prepare('SELECT size, offset FROM files WHERE path = ?')
const putFile = db.prepare('INSERT INTO files (path, size, offset) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET size = excluded.size, offset = excluded.offset')
const insertMsg = db.prepare('INSERT INTO messages (text, session_id, role, ts) VALUES (?, ?, ?, ?)')
const upsertSession = db.prepare(`
  INSERT INTO sessions (id, cwd, title, first_ts, last_ts, msg_count) VALUES (?, ?, ?, ?, ?, 1)
  ON CONFLICT(id) DO UPDATE SET
    cwd = COALESCE(sessions.cwd, excluded.cwd),
    title = COALESCE(sessions.title, excluded.title),
    last_ts = excluded.last_ts,
    msg_count = sessions.msg_count + 1
`)

let indexing = false

function indexFile(path: string) {
  const st = statSync(path)
  const prev = getFile.get(path) as { size: number; offset: number } | undefined
  let offset = prev && prev.size <= st.size ? prev.offset : 0
  if (offset >= st.size) return
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const buf = Buffer.alloc(Math.min(size - offset, 64 * 1024 * 1024))
    readSync(fd, buf, 0, buf.length, offset)
    const text = buf.toString('utf8')
    // Only consume complete lines; a half-written last line is picked up next time.
    const end = text.lastIndexOf('\n')
    if (end < 0) return
    db.exec('BEGIN')
    try {
      for (const line of text.slice(0, end).split('\n')) {
        const m = parseTranscriptLine(line)
        if (!m || !m.sessionId) continue
        insertMsg.run(m.text, m.sessionId, m.role, m.ts)
        const title = m.role === 'user' ? m.text.replace(/\s+/g, ' ').slice(0, 80) : null
        upsertSession.run(m.sessionId, m.cwd ?? null, title, m.ts, m.ts)
      }
      offset += Buffer.byteLength(text.slice(0, end + 1), 'utf8')
      putFile.run(path, size, offset)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  } finally {
    closeSync(fd)
  }
}

function indexAll() {
  if (indexing || !existsSync(projectsDir)) return
  indexing = true
  status()
  try {
    for (const project of readdirSync(projectsDir)) {
      const dir = join(projectsDir, project)
      let names: string[] = []
      try {
        names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
      } catch {
        continue
      }
      for (const n of names) {
        try {
          indexFile(join(dir, n))
        } catch (err) {
          port.postMessage({ type: 'log', text: `index ${n}: ${(err as Error).message}` })
        }
      }
    }
  } finally {
    indexing = false
    status()
  }
}

function status() {
  const s = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
  const m = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
  port.postMessage({ type: 'status', status: { available: true, indexing, sessions: s.n, messages: m.n } })
}

const searchStmt = db.prepare(`
  SELECT messages.session_id AS sessionId, messages.role AS role, messages.ts AS ts,
         snippet(messages, 0, '\u0001', '\u0002', '…', 24) AS snippet,
         COALESCE(s.cwd, '') AS cwd, COALESCE(s.title, '') AS title
  FROM messages LEFT JOIN sessions s ON s.id = messages.session_id
  WHERE messages MATCH ?
  ORDER BY bm25(messages) LIMIT ?
`)

const recentStmt = db.prepare(`
  SELECT id AS sessionId, 'user' AS role, last_ts AS ts, COALESCE(title, '') AS snippet,
         COALESCE(cwd, '') AS cwd, COALESCE(title, '') AS title
  FROM sessions ORDER BY last_ts DESC LIMIT ?
`)

function search(q: string, limit: number): SearchHit[] {
  const fts = toFtsQuery(q)
  if (!fts) return recentStmt.all(limit) as unknown as SearchHit[]
  return searchStmt.all(fts, limit) as unknown as SearchHit[]
}

port.on('message', (m: { type: string; id?: number; q?: string; limit?: number }) => {
  try {
    if (m.type === 'index') indexAll()
    else if (m.type === 'search') port.postMessage({ type: 'result', id: m.id, hits: search(m.q ?? '', m.limit ?? 50) })
  } catch (err) {
    port.postMessage({ type: 'result', id: m.id, error: (err as Error).message, hits: [] })
  }
})

status()
