// End-to-end smoke test, enabled with HIVE_SMOKE=1. Starts a real Claude session, sends a prompt that
// needs permission, approves it through Hive, waits for the turn to finish, screenshots and quits.
//   HIVE_HOME=<tmp> HIVE_SMOKE=1 HIVE_SMOKE_CWD=<dir> electron .
import { app, desktopCapturer, screen as electronScreen, type BrowserWindow } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionManager } from './sessionManager'

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?<>]*[a-zA-Z~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g

export function runSmoke(sessions: SessionManager, getWin: () => BrowserWindow | undefined, out: string) {
  const cwd = process.env.HIVE_SMOKE_CWD || process.cwd()
  const remote = !!process.env.HIVE_SMOKE_REMOTE
  const log: string[] = []
  const note = (s: string) => {
    log.push(`${new Date().toISOString()} ${s}`)
    console.log('[smoke]', s)
  }
  let finished = false
  const finish = async (ok: boolean) => {
    if (finished) return
    finished = true
    note(ok ? 'PASS' : 'FAIL')
    if (process.env.HIVE_SMOKE_BLUR) {
      // Grab the whole screen so the taskbar badge can be checked.
      try {
        await new Promise((r) => setTimeout(r, 1500))
        const { width, height } = electronScreen.getPrimaryDisplay().size
        const sf = electronScreen.getPrimaryDisplay().scaleFactor
        const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: width * sf, height: height * sf } })
        if (src) writeFileSync(join(out, 'screen.png'), src.thumbnail.toPNG())
      } catch (err) {
        note(`screen capture failed: ${(err as Error).message}`)
      }
    }
    try {
      const img = await getWin()?.webContents.capturePage()
      if (img) writeFileSync(join(out, 'smoke.png'), img.toPNG())
    } catch (err) {
      note(`screenshot failed: ${(err as Error).message}`)
    }
    writeFileSync(join(out, 'smoke.log'), log.join('\n'))
    app.exit(ok ? 0 : 1)
  }

  const shot = async (name: string) => {
    try {
      const img = await getWin()?.webContents.capturePage()
      if (img) writeFileSync(join(out, `${name}.png`), img.toPNG())
    } catch {
      /* ignore */
    }
  }
  let shotWorking = false

  const s = sessions.create({ cwd, title: 'Smoke test' })
  const screen = () => sessions.scrollback(s.id).text.replace(ANSI, '')
  note(`created ${s.shortCode} in ${cwd}`)
  // Look away from Hive so the finished turn counts as unseen (badge + chime).
  if (process.env.HIVE_SMOKE_BLUR) setTimeout(() => getWin()?.blur(), 3000)
  let prompted = false
  let sawPermission = false
  let trustSeen = false
  let idleSeen = false
  const sendPrompt = () => {
    if (prompted) return
    prompted = true
    sessions.sendPrompt(s.id, 'Use the Bash tool to run exactly: echo hive-smoke > smoke.txt   Then reply with just the word DONE.')
  }

  sessions.on('update', (u) => {
    if (u.id !== s.id) return
    if (u.status === 'working' && !shotWorking) {
      shotWorking = true
      setTimeout(() => void shot('state-working'), 300)
    }
    note(`status=${u.status}${u.pending ? ` pending=${u.pending.summary} held=${u.pending.held}` : ''}`)
    if (u.status === 'exited') {
      note(`exit code ${u.exitCode}; output:\n${screen().slice(-3000)}`)
      void finish(false)
    }
    // First run in a folder: Hive shows its trust bar; screenshot it, then trust like a user would.
    if (u.trustPrompt && !trustSeen) {
      trustSeen = true
      note('trust prompt detected')
      setTimeout(async () => {
        try {
          const img = await getWin()?.webContents.capturePage()
          if (img) writeFileSync(join(out, 'trust.png'), img.toPNG())
        } catch {
          /* ignore */
        }
        sessions.answerTrust(s.id, true)
        setTimeout(sendPrompt, 5000)
      }, 1500)
    }
    if (u.status === 'idle' && !idleSeen) {
      idleSeen = true
      setTimeout(() => {
        if (!trustSeen) sendPrompt()
      }, 2500)
    }
  })

  sessions.on('permission', (u, p) => {
    if (u.id !== s.id) return
    sawPermission = true
    if (remote) return note(`permission held: ${p.summary}; waiting for the phone`)
    note(`permission held: ${p.summary}; approving in 1s`)
    setTimeout(() => void shot('state-permission'), 400)
    setTimeout(() => sessions.answerPermission(s.id, p.requestId, { behavior: 'allow' }), 1000)
  })

  sessions.on('signal', (u, sig) => {
    if (u.id !== s.id) return
    note(`signal ${sig.type}${'message' in sig && sig.message ? `: ${String(sig.message).slice(0, 120)}` : ''}`)
    if (sig.type === 'finished' && prompted && remote) {
      // Remote mode: the phone sends a follow-up after the first turn; pass when Claude answers it.
      if (String(sig.message ?? '').includes('AGAIN')) setTimeout(() => void finish(existsSync(join(cwd, 'smoke.txt')) && sawPermission), 1500)
      return
    }
    if (sig.type === 'finished' && prompted) {
      const made = existsSync(join(cwd, 'smoke.txt'))
      note(`smoke.txt exists=${made} sawPermission=${sawPermission} title="${u.title}"`)
      setTimeout(() => void finish(made), 1500)
    }
  })

  setTimeout(() => {
    note(`timeout; screen:\n${screen().slice(-3000)}`)
    void finish(false)
  }, 180_000)
}

/** HIVE_SCREENSHOTS=1: captures the main screens for docs and visual checks, then quits. */
export async function runScreenshots(getWin: () => BrowserWindow | undefined, out: string) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const shot = async (name: string) => {
    const img = await getWin()?.webContents.capturePage()
    if (img) writeFileSync(join(out, `${name}.png`), img.toPNG())
  }
  const js = (code: string) => getWin()?.webContents.executeJavaScript(code)
  await wait(2500)
  await shot('01-empty')
  await js(`document.querySelector('[aria-label="Plugins"]').click()`)
  await wait(600)
  await js(`document.querySelector('.plugin-head').click()`)
  await wait(500)
  await shot('02-plugins')
  await js(`[...document.querySelectorAll('.tabs button')].find(b => b.textContent === 'General').click()`)
  await wait(400)
  await shot('03-general')
  app.exit(0)
}
