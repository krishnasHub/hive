import { useEffect, useRef, type ReactNode } from 'react'

export interface MenuItem {
  label: ReactNode
  hint?: string
  checked?: boolean
  onSelect(): void
}

/** A dropdown anchored under its trigger. Closes on outside click or Escape. */
export function Menu({ items, onClose, align = 'left' }: { items: (MenuItem | 'separator')[]; onClose(): void; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  return (
    <div ref={ref} className={`menu ${align}`} role="menu">
      {items.map((it, i) =>
        it === 'separator' ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className="menu-item"
            onClick={() => {
              onClose()
              it.onSelect()
            }}
          >
            <span className="menu-check">{it.checked ? '✓' : ''}</span>
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        )
      )}
    </div>
  )
}
