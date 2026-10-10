import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ActivityEntry, HiveSettings, InboundReply, OutboundMessage, PresenceMode, SessionInfo } from '@shared/types'
import { infoMessage, NotificationRouter, statusText } from '@core/notificationRouter'
import { HistoryIndex } from './history'
import { HookServer } from './hookServer'
import { ensureDirs, paths } from './paths'
import { PluginHost } from './pluginHost'
import { PresenceTracker } from './presence'
import { SessionManager } from './sessionManager'
import { SettingsStore } from './store'
import { locateClaude } from './claudeLocator'
import { runScreenshots, runSmoke } from './smoke'

// GUI apps on macOS/Linux don't inherit your shell PATH, so `claude` (and the tools it runs) go missing.
function adoptLoginShellPath() {
  if (process.platform === 'win32') return
  try {
    const shellPath = process.env.SHELL || '/bin/bash'
    const out = execFileSync(shellPath, ['-ilc', 'printf "__HIVE_PATH__%s" "$PATH"'], { encoding: 'utf8', timeout: 4000 })
    const p = out.split('__HIVE_PATH__')[1]
    if (p) process.env.PATH = p.trim()
  } catch {
    /* keep what we have */
  }
}

if (!app.requestSingleInstanceLock()) app.quit()

adoptLoginShellPath()
ensureDirs()

const store = new SettingsStore()
const presence = new PresenceTracker(() => store.get().notifications.awayAfterSec)
const sessions = new SessionManager(store, () => presence.get())
const hooks = new HookServer(sessions.handleHook)
const plugins = new PluginHost(store)
const history = new HistoryIndex()
let win: BrowserWindow | undefined

// ---------- activity log (audit trail of notifications and remote actions) ----------

const activity: ActivityEntry[] = []
function logActivity(text: string, session?: SessionInfo) {
  const e: ActivityEntry = { ts: Date.now(), sessionCode: session?.shortCode, text }
  activity.push(e)
  if (activity.length > 300) activity.shift()
  win?.webContents.send('activity:entry', e)
  try {
    appendFileSync(join(paths.logs, 'activity.log'), `${new Date(e.ts).toISOString()} ${e.sessionCode ?? '---'} ${text}\n`)
  } catch {
    /* logging is best effort */
  }
}

// ---------- notifications ----------

const router = new NotificationRouter({
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
  newId: () => randomUUID(),
  settings: () => store.get().notifications,
  presence: () => presence.get(),
  getSession: (id) => sessions.get(id),
  listSessions: () => sessions.list(),
  channels: () => plugins.runningChannels(),
  sendToChannel: async (channelId, msg) => {
    const r = await plugins.send(channelId, msg)
    logActivity(`→ ${channelId}: ${msg.title}`, msg.sessionId ? sessions.get(msg.sessionId) : undefined)
    return r
  },
  desktop: (msg) => showToast(msg),
  log: (text) => logActivity(text)
})

function showToast(msg: OutboundMessage) {
  if (!Notification.isSupported()) return
  // Looking at Hive already? The tab badge is enough.
  if (win && win.isFocused() && !win.isMinimized()) return
  const n = new Notification({ title: msg.title, body: msg.detail ? `${msg.body}\n${msg.detail}` : msg.body, silent: false })
  n.on('click', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (msg.sessionId) win.webContents.send('sessions:focus', msg.sessionId)
  })
  n.show()
}

sessions.on('signal', (s, sig) => {
  const n = store.get().notifications
  switch (sig.type) {
    case 'finished':
      history.reindexSoon()
      if (sig.durationMs >= n.finishedMinSec * 1000) router.notify(s, 'finished', sig.message || 'Claude finished its turn.')
      else router.cancel(s.id)
      break
    case 'waiting':
      router.notify(s, 'waiting', sig.message)
      break
    case 'permission_prompt':
      router.notify(s, 'permission', sig.message, { detail: s.pending?.summary })
      break
    case 'activity':
    case 'ended':
      router.cancel(s.id)
      break
  }
})

sessions.on('permission', (s, pending) => {
  router.notify(s, 'permission', `Claude wants to use ${pending.toolName}.`, { detail: pending.summary, requestId: pending.requestId })
})

// ---------- replies from your phone ----------

async function ack(reply: InboundReply, text: string, session?: SessionInfo) {
  try {
    await plugins.send(reply.channelId, infoMessage(randomUUID(), text, reply.threadRef, session))
  } catch (err) {
    logActivity(`Could not reply on ${reply.channelId}: ${(err as Error).message}`)
  }
}

async function handleReply(reply: InboundReply) {
  const r = router.resolveReply(reply)
  if ('error' in r) {
    logActivity(`← ${reply.channelId}: "${reply.text}" (not routed: ${r.error})`)
    return ack(reply, r.error)
  }
  const { session, action } = r
  const who = `${reply.channelId}${reply.from ? ` (${reply.from})` : ''}`
  const pending = session.pending
  const tag = `[${session.shortCode}]`

  switch (action.type) {
    case 'approve':
      if (pending) {
        sessions.answerPermission(session.id, pending.requestId, { behavior: 'allow' })
        logActivity(`← ${who}: approved ${pending.summary}`, session)
        if (action.followUp) setTimeout(() => sessions.sendPrompt(session.id, action.followUp!), 400)
        return ack(reply, `✓ Approved ${tag}${action.followUp ? ' and queued your note' : ''}`, session)
      }
      break // nothing to approve: treat "yes" as an answer to Claude's question
    case 'deny':
      if (pending) {
        sessions.answerPermission(session.id, pending.requestId, {
          behavior: 'deny',
          message: action.reason ? `The user declined and said: ${action.reason}` : 'The user declined this action.'
        })
        logActivity(`← ${who}: denied ${pending.summary}${action.reason ? ` — "${action.reason}"` : ''}`, session)
        return ack(reply, `✓ Denied ${tag}`, session)
      }
      break
    case 'stop':
      sessions.interrupt(session.id)
      logActivity(`← ${who}: stop`, session)
      return ack(reply, `⏹ Interrupted ${tag}`, session)
    case 'status':
      logActivity(`← ${who}: status`, session)
      return ack(reply, statusText(session, Date.now()), session)
    case 'text':
      break
  }

  const text = reply.text.trim()
  if (!text) return
  if (pending?.held) {
    // An instruction instead of yes/no: decline the tool call and tell Claude what to do instead.
    sessions.answerPermission(session.id, pending.requestId, { behavior: 'deny', message: `The user replied instead: ${text}` })
    logActivity(`← ${who}: redirected "${text}"`, session)
    return ack(reply, `✓ Sent to ${tag} instead of the pending action`, session)
  }
  sessions.sendPrompt(session.id, text)
  router.cancel(session.id)
  logActivity(`← ${who}: "${text}"`, session)
  return ack(reply, `✓ Sent to ${tag}`, session)
}

plugins.on('reply', (r) => void handleReply(r))
plugins.on('log', (id, level, text) => {
  const line = `[plugin:${id}] ${text}`
  if (level === 'error') console.error(line)
  else console.log(line)
  try {
    appendFileSync(join(paths.logs, `plugin-${id}.log`), `${new Date().toISOString()} ${level} ${text}\n`)
  } catch {
    /* best effort */
  }
})

// ---------- window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 720,
    minHeight: 420,
    show: false,
    backgroundColor: '#0f1115',
    title: 'Hive',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => (win = undefined))
  win.on('focus', () => win?.flashFrame(false))

  // Links never navigate the app window; they open in your browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      void openExternal(url)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

async function openExternal(url: string) {
  try {
    const u = new URL(url)
    if (['http:', 'https:', 'mailto:'].includes(u.protocol)) await shell.openExternal(u.toString())
  } catch {
    /* not a URL */
  }
}

function broadcast(channel: string, ...args: unknown[]) {
  win?.webContents.send(channel, ...args)
}

sessions.on('update', (s) => broadcast('sessions:update', s))
sessions.on('data', (id, d, end) => broadcast('sessions:data', id, d, end))
sessions.on('removed', (id) => broadcast('sessions:removed', id))
sessions.on('error', (id, m) => broadcast('sessions:error', id, m))
plugins.on('change', () => broadcast('plugins:change'))
history.on('status', (s) => broadcast('history:status', s))
presence.on('change', (p) => broadcast('presence:change', { presence: p, mode: presence.mode }))

// ---------- IPC ----------

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

function registerIpc() {
  ipcMain.handle('sessions:list', () => sessions.list())
  ipcMain.handle('sessions:create', (_e, o: { cwd?: string; title?: string; resumeClaudeSessionId?: string }) => {
    if (o.resumeClaudeSessionId) {
      const open = sessions.findByClaudeSessionId(o.resumeClaudeSessionId)
      if (open) {
        sessions.start(open.id)
        return open
      }
    }
    return sessions.create({ cwd: o.cwd || store.get().general.defaultCwd, title: o.title, resumeClaudeSessionId: o.resumeClaudeSessionId })
  })
  ipcMain.handle('sessions:start', (_e, id: string) => sessions.start(id))
  ipcMain.handle('sessions:close', (_e, id: string) => {
    router.cancel(id)
    sessions.close(id)
  })
  ipcMain.handle('sessions:rename', (_e, id: string, title: string) => sessions.rename(id, title))
  ipcMain.on('sessions:write', (_e, id: string, data: string) => sessions.write(id, data))
  ipcMain.on('sessions:resize', (_e, id: string, cols: number, rows: number) => sessions.resize(id, cols, rows))
  ipcMain.handle('sessions:scrollback', (_e, id: string) => sessions.scrollback(id))
  ipcMain.handle('sessions:answerPermission', (_e, id: string, requestId: string, answer: 'allow' | 'deny' | 'terminal') => {
    const s = sessions.get(id)
    sessions.answerPermission(id, requestId, answer === 'deny' ? { behavior: 'deny', message: 'The user declined this action.' } : { behavior: answer })
    if (s?.pending) logActivity(`Hive: ${answer === 'terminal' ? 'sent to terminal' : answer} ${s.pending.summary}`, s)
  })
  ipcMain.handle('sessions:interrupt', (_e, id: string) => sessions.interrupt(id))

  ipcMain.handle('attachments:saveImage', (_e, sessionId: string, bytes: ArrayBuffer, mime: string) => {
    const ext = IMAGE_EXT[mime] ?? 'png'
    const dir = join(paths.attachments, sessionId.replace(/[^a-zA-Z0-9-]/g, ''))
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `pasted-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`)
    writeFileSync(file, Buffer.from(bytes))
    return file
  })

  ipcMain.handle('settings:get', () => store.get())
  ipcMain.handle('settings:update', (_e, patch: Partial<HiveSettings>) => store.update(patch))
  ipcMain.handle('settings:detectClaude', () => locateClaude() ?? null)

  ipcMain.handle('plugins:list', () => plugins.list())
  ipcMain.handle('plugins:setEnabled', (_e, id: string, enabled: boolean) => plugins.setEnabled(id, enabled))
  ipcMain.handle('plugins:configure', (_e, id: string, values: Record<string, unknown>) => plugins.configure(id, values))
  ipcMain.handle('plugins:test', async (_e, id: string) => {
    try {
      return { ok: true, message: await plugins.test(id) }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })
  ipcMain.handle('plugins:openFolder', () => shell.openPath(paths.userPlugins))

  ipcMain.handle('presence:get', () => ({ presence: presence.get(), mode: presence.mode }))
  ipcMain.handle('presence:setMode', (_e, mode: PresenceMode) => {
    presence.setMode(mode)
    broadcast('presence:change', { presence: presence.get(), mode: presence.mode })
  })

  ipcMain.handle('history:search', (_e, q: string) => history.search(q))
  ipcMain.handle('history:status', () => history.status)
  ipcMain.handle('history:reindex', () => history.reindex())

  ipcMain.handle('activity:list', () => activity)

  ipcMain.handle('app:openExternal', (_e, url: string) => openExternal(url))
  ipcMain.handle('app:pickFolder', async (_e, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], defaultPath })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('app:showItem', (_e, p: string) => shell.showItemInFolder(p))
}

// ---------- lifecycle ----------

app.on('second-instance', () => {
  if (!win) return createWindow()
  if (win.isMinimized()) win.restore()
  win.focus()
})

app.whenReady().then(async () => {
  app.setAppUserModelId('dev.hive.desktop') // Windows toasts need this
  const port = await hooks.start()
  sessions.setHookEndpoint(port, hooks.token)
  sessions.restore()
  registerIpc()
  presence.start()
  plugins.discover()
  plugins.startEnabled()
  history.start()
  createWindow()
  if (process.env.HIVE_SMOKE) runSmoke(sessions, () => win, paths.logs)
  if (process.env.HIVE_SCREENSHOTS) void runScreenshots(() => win, paths.logs)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  sessions.shutdown()
  plugins.stopAll()
  history.stop()
  presence.stop()
  hooks.stop()
})
