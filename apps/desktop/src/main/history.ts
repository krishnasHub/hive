// Main-process side of history search: owns the worker, re-indexes periodically and after each turn.
import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import workerPath from './historyWorker?modulePath'
import type { IndexStatus, SearchHit } from '@shared/types'
import { paths } from './paths'

export class HistoryIndex extends EventEmitter<{ status: [IndexStatus] }> {
  private worker?: Worker
  private seq = 0
  private waiting = new Map<number, (hits: SearchHit[]) => void>()
  private timer?: NodeJS.Timeout
  private debounce?: NodeJS.Timeout
  status: IndexStatus = { available: false, indexing: false, sessions: 0, messages: 0 }

  start() {
    try {
      this.worker = new Worker(workerPath, { workerData: { dbPath: paths.db, projectsDir: paths.claudeProjects } })
    } catch (err) {
      this.fail((err as Error).message)
      return
    }
    this.worker.on('message', (m: { type: string; id?: number; hits?: SearchHit[]; status?: IndexStatus; text?: string }) => {
      if (m.type === 'status' && m.status) {
        this.status = m.status
        this.emit('status', m.status)
      } else if (m.type === 'result' && m.id !== undefined) {
        this.waiting.get(m.id)?.(m.hits ?? [])
        this.waiting.delete(m.id)
      } else if (m.type === 'log') console.warn('[hive] history', m.text)
    })
    this.worker.on('error', (err) => this.fail(err.message))
    this.reindex()
    this.timer = setInterval(() => this.reindex(), 5 * 60_000)
  }

  private fail(message: string) {
    this.status = { available: false, indexing: false, sessions: 0, messages: 0, error: `History search unavailable: ${message}` }
    this.emit('status', this.status)
    for (const done of this.waiting.values()) done([])
    this.waiting.clear()
  }

  reindex() {
    this.worker?.postMessage({ type: 'index' })
  }

  /** Called after a turn finishes; batches bursts from many tabs. */
  reindexSoon() {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => this.reindex(), 3000)
  }

  search(q: string, limit = 50): Promise<SearchHit[]> {
    if (!this.worker || !this.status.available) return Promise.resolve([])
    const id = ++this.seq
    return new Promise((resolve) => {
      this.waiting.set(id, resolve)
      this.worker!.postMessage({ type: 'search', id, q, limit })
    })
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    void this.worker?.terminate()
  }
}
