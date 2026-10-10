import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { HiveApi } from '@shared/api'

function on<T extends unknown[]>(channel: string, fn: (...args: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => fn(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const invoke = ipcRenderer.invoke.bind(ipcRenderer)

const api: HiveApi = {
  platform: process.platform,
  sessions: {
    list: () => invoke('sessions:list'),
    create: (opts) => invoke('sessions:create', opts),
    start: (id) => invoke('sessions:start', id),
    close: (id) => invoke('sessions:close', id),
    rename: (id, title) => invoke('sessions:rename', id, title),
    write: (id, data) => ipcRenderer.send('sessions:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('sessions:resize', id, cols, rows),
    scrollback: (id) => invoke('sessions:scrollback', id),
    answerPermission: (id, requestId, answer) => invoke('sessions:answerPermission', id, requestId, answer),
    interrupt: (id) => invoke('sessions:interrupt', id),
    onData: (fn) => on('sessions:data', fn),
    onUpdate: (fn) => on('sessions:update', fn),
    onRemoved: (fn) => on('sessions:removed', fn),
    onError: (fn) => on('sessions:error', fn),
    onFocus: (fn) => on('sessions:focus', fn)
  },
  attachments: {
    saveImage: (sessionId, bytes, mime) => invoke('attachments:saveImage', sessionId, bytes, mime),
    pathForFile: (file) => webUtils.getPathForFile(file)
  },
  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch),
    detectClaude: () => invoke('settings:detectClaude')
  },
  plugins: {
    list: () => invoke('plugins:list'),
    setEnabled: (id, enabled) => invoke('plugins:setEnabled', id, enabled),
    configure: (id, values) => invoke('plugins:configure', id, values),
    test: (id) => invoke('plugins:test', id),
    openFolder: () => invoke('plugins:openFolder'),
    onChange: (fn) => on('plugins:change', fn)
  },
  presence: {
    get: () => invoke('presence:get'),
    setMode: (mode) => invoke('presence:setMode', mode),
    onChange: (fn) => on('presence:change', fn)
  },
  history: {
    search: (q) => invoke('history:search', q),
    status: () => invoke('history:status'),
    reindex: () => invoke('history:reindex'),
    onStatus: (fn) => on('history:status', fn)
  },
  activity: {
    list: () => invoke('activity:list'),
    onEntry: (fn) => on('activity:entry', fn)
  },
  app: {
    openExternal: (url) => invoke('app:openExternal', url),
    pickFolder: (defaultPath) => invoke('app:pickFolder', defaultPath),
    showItem: (path) => invoke('app:showItem', path)
  }
}

contextBridge.exposeInMainWorld('hive', api)
