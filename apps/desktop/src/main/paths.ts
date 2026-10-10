import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const hiveHome = process.env.HIVE_HOME || join(homedir(), '.hive')
export const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

export const paths = {
  settings: join(hiveHome, 'settings.json'),
  secrets: join(hiveHome, 'secrets.json'),
  sessions: join(hiveHome, 'sessions.json'),
  db: join(hiveHome, 'hive.db'),
  run: join(hiveHome, 'run'),
  attachments: join(hiveHome, 'attachments'),
  userPlugins: join(hiveHome, 'plugins'),
  pluginData: join(hiveHome, 'plugin-data'),
  logs: join(hiveHome, 'logs'),
  claudeProjects: join(claudeHome, 'projects')
}

/** Plugins shipped with the app (repo `plugins/` in dev, resources/plugins when packaged). */
export function builtinPluginsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'plugins') : join(app.getAppPath(), '..', '..', 'plugins')
}

export function ensureDirs() {
  for (const d of [hiveHome, paths.run, paths.attachments, paths.userPlugins, paths.pluginData, paths.logs]) {
    mkdirSync(d, { recursive: true })
  }
}
