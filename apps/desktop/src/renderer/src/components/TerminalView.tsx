import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import type { GeneralSettings } from '@shared/types'
import { attachTerminal } from '../terminals'

// Black background, white text, Windows Terminal "Campbell" colors.
const THEME = {
  background: '#0c0c0c',
  foreground: '#f2f2f2',
  cursor: '#ffffff',
  cursorAccent: '#0c0c0c',
  selectionBackground: '#ffffff40',
  black: '#0c0c0c',
  red: '#c50f1f',
  green: '#13a10e',
  yellow: '#c19c00',
  blue: '#0037da',
  magenta: '#881798',
  cyan: '#3a96dd',
  white: '#cccccc',
  brightBlack: '#767676',
  brightRed: '#e74856',
  brightGreen: '#16c60c',
  brightYellow: '#f9f1a5',
  brightBlue: '#3b78ff',
  brightMagenta: '#b4009e',
  brightCyan: '#61d6d6',
  brightWhite: '#f2f2f2'
}

/** Shell-quote a path for pasting into the prompt. */
function quotePath(p: string): string {
  if (!/[\s"'()&;|<>$`]/.test(p)) return p
  return `"${p.replace(/"/g, '\\"')}"`
}

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

interface Props {
  sessionId: string
  active: boolean
  general: GeneralSettings
  /** Keys the app wants (new tab, search, ...) must not reach Claude. */
  isAppShortcut: (e: KeyboardEvent) => boolean
}

export function TerminalView({ sessionId, active, general, isAppShortcut }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | undefined>(undefined)
  const fitRef = useRef<FitAddon | undefined>(undefined)
  const [dragging, setDragging] = useState(false)
  const shortcutRef = useRef(isAppShortcut)
  shortcutRef.current = isAppShortcut

  useEffect(() => {
    const el = host.current!
    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: general.fontFamily,
      fontSize: general.fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10_000,
      theme: THEME,
      macOptionIsMeta: true,
      linkHandler: {
        // OSC 8 hyperlinks (Claude Code emits these for files and URLs).
        activate: (_e, uri) => void window.hive.app.openExternal(uri),
        allowNonHttpProtocols: false
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => void window.hive.app.openExternal(uri)))
    const unicode = new Unicode11Addon()
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'
    term.open(el)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      /* falls back to the DOM renderer */
    }

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      if (shortcutRef.current(e)) return false
      const mod = e.ctrlKey || e.metaKey
      // Copy when there's a selection; otherwise Ctrl+C still interrupts Claude.
      if (mod && !e.altKey && e.key.toLowerCase() === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        term.clearSelection()
        return false
      }
      // Let the browser fire a paste event (handled below for images, by xterm for text).
      if (mod && !e.altKey && e.key.toLowerCase() === 'v') return false
      // Shift+Enter inserts a newline in Claude Code's prompt instead of submitting.
      if (e.key === 'Enter' && e.shiftKey && !mod) {
        window.hive.sessions.write(sessionId, '\x1b\r')
        return false
      }
      return true
    })

    term.onData((d) => window.hive.sessions.write(sessionId, d))
    term.onResize(({ cols, rows }) => window.hive.sessions.resize(sessionId, cols, rows))

    let detach: (() => void) | undefined
    let disposed = false
    void attachTerminal(sessionId, (d) => term.write(d)).then((fn) => {
      if (disposed) fn()
      else detach = fn
    })

    // Images on the clipboard become files Claude can read.
    const onPaste = async (e: ClipboardEvent) => {
      const items = [...(e.clipboardData?.items ?? [])]
      const images = items.filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
      if (!images.length) return
      e.preventDefault()
      e.stopPropagation()
      const paths: string[] = []
      for (const item of images) {
        const file = item.getAsFile()
        if (!file) continue
        paths.push(await window.hive.attachments.saveImage(sessionId, await file.arrayBuffer(), file.type))
      }
      if (paths.length) window.hive.sessions.write(sessionId, PASTE_START + paths.map(quotePath).join(' ') + ' ' + PASTE_END)
      term.focus()
    }
    el.addEventListener('paste', onPaste, true)

    const ro = new ResizeObserver(() => {
      if (el.offsetParent !== null) {
        try {
          fit.fit()
        } catch {
          /* not laid out yet */
        }
      }
    })
    ro.observe(el)

    termRef.current = term
    fitRef.current = fit
    return () => {
      disposed = true
      detach?.()
      ro.disconnect()
      el.removeEventListener('paste', onPaste, true)
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = general.fontSize
    term.options.fontFamily = general.fontFamily
    try {
      fitRef.current?.fit()
    } catch {
      /* ignore */
    }
  }, [general.fontSize, general.fontFamily])

  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* ignore */
      }
      termRef.current?.focus()
    }, 0)
    return () => clearTimeout(t)
  }, [active])

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const files = [...e.dataTransfer.files]
    if (!files.length) return
    const paths = files.map((f) => window.hive.attachments.pathForFile(f)).filter(Boolean)
    if (paths.length) window.hive.sessions.write(sessionId, PASTE_START + paths.map(quotePath).join(' ') + ' ' + PASTE_END)
    termRef.current?.focus()
  }

  return (
    <div
      className={`terminal-wrap ${active ? 'active' : ''} ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div ref={host} className="terminal-host" />
      {dragging && <div className="drop-hint">Drop files to add their paths to the prompt</div>}
    </div>
  )
}

export function focusTerminalSoon() {
  setTimeout(() => (document.querySelector('.terminal-wrap.active .xterm-helper-textarea') as HTMLElement | null)?.focus(), 0)
}
