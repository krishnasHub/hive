// Small stroke icons (16px), drawn inline so there are no icon-font dependencies.
import type { ReactNode } from 'react'

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}

export const PlusIcon = () => (
  <Svg>
    <path d="M8 3v10M3 8h10" />
  </Svg>
)
export const ChevronDownIcon = () => (
  <Svg size={12}>
    <path d="M4 6l4 4 4-4" />
  </Svg>
)
export const CloseIcon = () => (
  <Svg size={12}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
)
export const SearchIcon = () => (
  <Svg>
    <circle cx="7" cy="7" r="4.25" />
    <path d="M10.2 10.2L13.5 13.5" />
  </Svg>
)
export const ActivityIcon = () => (
  <Svg>
    <path d="M1.5 8h3l2-4.5 3 9 2-4.5h3" />
  </Svg>
)
export const PluginIcon = () => (
  <Svg>
    <path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v3a3.5 3.5 0 01-7 0v-3zM8 12v2" />
  </Svg>
)
export const GearIcon = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)
export const FolderIcon = () => (
  <Svg>
    <path d="M1.8 4.2c0-.6.4-1 1-1h3.1l1.4 1.6h5.9c.6 0 1 .4 1 1v6.2c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1V4.2z" />
  </Svg>
)
export const PersonIcon = ({ away }: { away: boolean }) => (
  <Svg>
    <circle cx="8" cy="5.5" r="2.5" />
    <path d="M3 13.5c.6-2.4 2.6-3.8 5-3.8s4.4 1.4 5 3.8" />
    {away && <circle cx="13" cy="3" r="2" fill="#f5b301" stroke="#1b1b1b" strokeWidth={1} />}
  </Svg>
)
export const InboxIcon = () => (
  <Svg>
    <path d="M2 9l1.8-5.2c.15-.45.55-.8 1.05-.8h6.3c.5 0 .9.35 1.05.8L14 9v3c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1V9z" />
    <path d="M2 9h3.2l.8 1.6h4l.8-1.6H14" />
  </Svg>
)
