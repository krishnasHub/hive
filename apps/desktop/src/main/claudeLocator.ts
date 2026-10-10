// Finds the `claude` executable the user already has installed.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const isWin = process.platform === 'win32'

function candidatesOnPath(): string[] {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  // Common install locations that GUI apps often miss because they don't inherit the shell PATH.
  dirs.push(
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.claude', 'local'),
    join(homedir(), '.npm-global', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  )
  if (isWin && process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm'))
  const names = isWin ? ['claude.exe', 'claude.cmd'] : ['claude']
  const out: string[] = []
  for (const d of dirs) for (const n of names) out.push(join(d, n))
  return out
}

export function locateClaude(override?: string): string | undefined {
  if (override && existsSync(override)) return override
  return candidatesOnPath().find((p) => existsSync(p))
}

/** node-pty can't launch .cmd shims directly on Windows. */
export function spawnTarget(claudePath: string, args: string[]): { file: string; args: string[] } {
  if (isWin && /\.(cmd|bat)$/i.test(claudePath)) {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', claudePath, ...args] }
  }
  return { file: claudePath, args }
}
