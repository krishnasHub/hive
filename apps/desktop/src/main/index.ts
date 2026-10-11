import { app, BrowserWindow, dialog, ipcMain, nativeImage, Notification, shell } from 'electron'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ActivityEntry, HiveSettings, InboundReply, OutboundMessage, PresenceMode, SessionInfo } from '@shared/types'
import { infoMessage, NotificationRouter, statusText } from '@core/notificationRouter'
import { Assistant } from './assistant'
import { HistoryIndex } from './history'
import { HookServer } from './hookServer'
import { ensureDirs, paths } from './paths'
import { PluginHost } from './pluginHost'
import { PowerManager } from './power'
import { PresenceTracker } from './presence'
import { SessionManager } from './sessionManager'
import { SettingsStore } from './store'
import { locateClaude } from './claudeLocator'
import { runScreenshots, runSmoke } from './smoke'
import { appIcon, applyLoginItem, HiveTray } from './tray'

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
const power = new PowerManager({ stateFile: paths.lidState, log: (text) => logActivity(text) })
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

const router: NotificationRouter = new NotificationRouter({
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
  alertPending: (key): boolean => assistant.isPending(key),
  log: (text) => logActivity(text)
})

const assistant: Assistant = new Assistant({ store, router, newId: () => randomUUID(), log: (text) => logActivity(text) })

function showToast(msg: OutboundMessage) {
  if (!Notification.isSupported()) return
  // Looking at Hive already? The tab badge is enough.
  if (win && win.isFocused() && !win.isMinimized()) return
  // Hive plays its own chime, so keep the OS toast quiet unless sounds are off in Hive.
  const silent = store.get().notifications.sound
  const n = new Notification({ title: msg.title, body: msg.detail ? `${msg.body}\n${msg.detail}` : msg.body, silent })
  n.on('click', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (msg.kind === 'alert') win.webContents.send('assistant:openInbox')
    else if (msg.sessionId) win.webContents.send('sessions:focus', msg.sessionId)
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

async function ack(reply: InboundReply, text: string, session?: SessionInfo, alertKey?: string) {
  try {
    const { threadRef } = await plugins.send(reply.channelId, infoMessage(randomUUID(), text, reply.threadRef, session))
    // Replying to the ack itself should reach the same place.
    if (threadRef && session) router.rememberThread(reply.channelId, threadRef, { sessionId: session.id })
    else if (threadRef && alertKey) router.rememberThread(reply.channelId, threadRef, { alertKey })
  } catch (err) {
    logActivity(`Could not reply on ${reply.channelId}: ${(err as Error).message}`)
  }
}

async function handleReply(reply: InboundReply) {
  const r = router.resolveReply(reply)
  const who = `${reply.channelId}${reply.from ? ` (${reply.from})` : ''}`
  if ('error' in r) {
    logActivity(`← ${reply.channelId}: "${reply.text}" (not routed: ${r.error})`)
    return ack(reply, r.error)
  }
  if ('alertKey' in r) {
    logActivity(`← ${who}: "${r.text || r.actionId}" on an alert`)
    return ack(reply, assistant.handleReply(r.alertKey, r.text, r.actionId), undefined, r.alertKey)
  }
  const { session, action } = r
  const pending = session.pending
  // Claude's own permission dialog is up (Hive isn't holding it): answer with keys instead of typing text into it.
  const dialog = !pending && session.status === 'waiting_permission'
  const what = pending?.summary ?? 'the permission prompt'
  const tag = `[${session.shortCode}]`

  switch (action.type) {
    case 'approve':
      if (pending || dialog) {
        sessions.answerPermission(session.id, pending?.requestId ?? '', { behavior: 'allow' })
        logActivity(`← ${who}: approved ${what}`, session)
        if (action.followUp) setTimeout(() => sessions.sendPrompt(session.id, action.followUp!), 400)
        return ack(reply, `✓ Approved ${tag}${action.followUp ? ' and queued your note' : ''}`, session)
      }
      break // nothing to approve: treat "yes" as an answer to Claude's question
    case 'deny':
      if (pending || dialog) {
        sessions.answerPermission(session.id, pending?.requestId ?? '', {
          behavior: 'deny',
          message: action.reason ? `The user declined and said: ${action.reason}` : 'The user declined this action.'
        })
        // Esc on Claude's own dialog drops back to the prompt; pass the reason on as the next message.
        if (dialog && action.reason) setTimeout(() => sessions.sendPrompt(session.id, action.reason!), 400)
        logActivity(`← ${who}: denied ${what}${action.reason ? ` — "${action.reason}"` : ''}`, session)
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
  if (dialog) {
    sessions.answerPermission(session.id, '', { behavior: 'deny' })
    setTimeout(() => sessions.sendPrompt(session.id, text), 400)
    logActivity(`← ${who}: redirected "${text}"`, session)
    return ack(reply, `✓ Sent to ${tag} instead of the pending action`, session)
  }
  sessions.sendPrompt(session.id, text)
  router.cancel(session.id)
  logActivity(`← ${who}: "${text}"`, session)
  return ack(reply, `✓ Sent to ${tag}`, session)
}

plugins.on('reply', (r) => void handleReply(r))
plugins.on('items', ({ sourceId, sourceLabel, items }) => assistant.ingest(sourceId, sourceLabel, items))
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

const isMac = process.platform === 'darwin'
export const TITLEBAR_HEIGHT = 40
let quitting = false

function createWindow(showOnReady = true) {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 640,
    minHeight: 400,
    show: false,
    backgroundColor: '#0c0c0c',
    title: 'Hive',
    icon: isMac ? undefined : appIcon(),
    autoHideMenuBar: true,
    // Tabs live in the title bar, like Windows Terminal. The OS still draws the window buttons.
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { color: '#1b1b1b', symbolColor: '#d4d4d4', height: TITLEBAR_HEIGHT } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // Hidden in the tray, the page still has to chime and update the badge when a session finishes.
      backgroundThrottling: false
    }
  })
  win.once('ready-to-show', () => showOnReady && win?.show())
  win.on('closed', () => (win = undefined))
  // Closing the window hides Hive to the tray so sessions and notifications keep running.
  win.on('close', (e) => {
    if (quitting || !store.get().general.closeToTray) return
    e.preventDefault()
    win?.hide()
    if (!store.get().general.trayHintShown) {
      store.update({ general: { ...store.get().general, trayHintShown: true } })
      if (Notification.isSupported()) {
        new Notification({ title: 'Hive is still running', body: 'Your sessions keep going and Hive will still notify you. Quit from the tray icon.', silent: true }).show()
      }
    }
  })
  win.on('focus', () => win?.flashFrame(false))
  // The title carries the badge count ("(2) Hive"); don't let the page's <title> reset it.
  win.on('page-title-updated', (e) => e.preventDefault())

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

function showWindow() {
  if (!win) createWindow()
  if (win!.isMinimized()) win!.restore()
  win!.show()
  win!.focus()
}

const tray = new HiveTray({
  show: showWindow,
  quit: () => app.quit(),
  presenceMode: () => presence.mode,
  setPresenceMode: (mode) => {
    presence.setMode(mode)
    broadcast('presence:change', { presence: presence.get(), mode: presence.mode })
  }
})

async function openExternal(url: string) {
  try {
    const u = new URL(url)
    if (['http:', 'https:', 'mailto:'].includes(u.protocol)) await shell.openExternal(u.toString())
  } catch {
    /* not a URL */
  }
}

let badgeCount = 0

/** "1" on the taskbar icon (Windows overlay, macOS dock, Linux launcher) plus "(1) Hive" in the title. */
function setBadge(count: number, overlayDataUrl: string | null) {
  const prev = badgeCount
  badgeCount = Math.max(0, Math.floor(count))
  tray.setCount(badgeCount)
  if (!win) return
  win.setTitle(badgeCount ? `(${badgeCount}) Hive` : 'Hive')
  if (process.platform === 'win32') {
    const img = badgeCount && overlayDataUrl ? nativeImage.createFromDataURL(overlayDataUrl) : null
    win.setOverlayIcon(img, badgeCount ? `${badgeCount} session${badgeCount === 1 ? '' : 's'} need you` : '')
  } else {
    app.setBadgeCount(badgeCount)
  }
  // Something new while you're in another app: flash the taskbar button until you come back.
  if (badgeCount > prev && !win.isFocused()) win.flashFrame(true)
  if (process.env.HIVE_SMOKE) console.log(`[smoke] badge=${badgeCount}`)
}

function broadcast(channel: string, ...args: unknown[]) {
  win?.webContents.send(channel, ...args)
}

sessions.on('update', (s) => {
  broadcast('sessions:update', s)
  updatePower()
})
sessions.on('data', (id, d, end) => broadcast('sessions:data', id, d, end))
sessions.on('removed', (id) => broadcast('sessions:removed', id))
sessions.on('trusted', (s) => logActivity(`Trusted folder automatically: ${s.cwd}`, s))
sessions.on('error', (id, m) => broadcast('sessions:error', id, m))
plugins.on('change', () => broadcast('plugins:change'))
assistant.on('change', () => broadcast('assistant:change'))
power.on('status', (st) => broadcast('power:status', st))

/** Working sessions, and ones holding a permission prompt for your phone, keep the computer awake. */
function updatePower() {
  const active = sessions.list().filter((s) => s.status === 'working' || (s.status === 'waiting_permission' && s.pending?.held)).length
  const g = store.get().general
  power.update(active, { keepAwake: g.keepAwake, lidClosed: g.lidClosed })
}
history.on('status', (s) => broadcast('history:status', s))
presence.on('change', (p) => {
  broadcast('presence:change', { presence: p, mode: presence.mode })
  tray.refresh()
})

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
  ipcMain.handle('sessions:answerTrust', (_e, id: string, trust: boolean) => sessions.answerTrust(id, trust))

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
    tray.refresh()
  })

  ipcMain.handle('history:search', (_e, q: string) => history.search(q))
  ipcMain.handle('history:status', () => history.status)
  ipcMain.handle('history:reindex', () => history.reindex())

  ipcMain.handle('activity:list', () => activity)

  ipcMain.handle('assistant:list', () => assistant.list())
  ipcMain.handle('assistant:stats', () => assistant.getStats())
  ipcMain.handle('assistant:muteSender', (_e, sender: string) => assistant.muteSender(sender))
  ipcMain.handle('assistant:markAllSeen', () => assistant.markAllSeen())
  ipcMain.handle('assistant:retryErrors', () => assistant.retryErrors())
  ipcMain.handle('power:status', () => power.status())

  ipcMain.handle('app:openExternal', (_e, url: string) => openExternal(url))
  ipcMain.handle('app:pickFolder', async (_e, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], defaultPath })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('app:showItem', (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.on('app:setBadge', (_e, count: number, overlayDataUrl: string | null) => setBadge(count, overlayDataUrl))
}

// ---------- lifecycle ----------

app.on('second-instance', () => showWindow())

app.whenReady().then(async () => {
  // Windows only shows toasts for a registered AppUserModelID; unpackaged dev builds must use the exe path.
  app.setAppUserModelId(app.isPackaged ? 'dev.hive.desktop' : process.execPath)
  const port = await hooks.start()
  sessions.setHookEndpoint(port, hooks.token)
  sessions.restore()
  registerIpc()
  power.recover()
  store.onChange(() => updatePower())
  updatePower()
  assistant.load()
  presence.start()
  plugins.discover()
  plugins.startEnabled()
  history.start()
  tray.create()
  applyLoginItem(store.get().general.launchAtLogin)
  store.onChange((s) => applyLoginItem(s.general.launchAtLogin))
  // Started at login: stay in the tray until you open it.
  createWindow(!process.argv.includes('--hidden'))
  if (process.env.HIVE_SMOKE) runSmoke(sessions, () => win, paths.logs)
  if (process.env.HIVE_SCREENSHOTS) void runScreenshots(() => win, paths.logs)
  app.on('activate', () => showWindow())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
  tray.destroy()
  sessions.shutdown()
  assistant.stop()
  power.dispose()
  plugins.stopAll()
  history.stop()
  presence.stop()
  hooks.stop()
})
