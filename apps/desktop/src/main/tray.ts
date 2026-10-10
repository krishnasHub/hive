// System tray: keeps Hive (and your sessions and notifications) running after you close the window.
import { app, Menu, nativeImage, Tray, type NativeImage } from 'electron'
import { join } from 'node:path'
import type { PresenceMode } from '@shared/types'

export function resourcePath(name: string): string {
  return join(app.getAppPath(), 'resources', name)
}

function trayImage(alert: boolean): NativeImage {
  const base = alert ? 'tray-alert' : 'tray'
  const img = nativeImage.createFromPath(resourcePath(`${base}-16.png`))
  // Hi-DPI tray icons.
  const hi = nativeImage.createFromPath(resourcePath(`${base}-32.png`))
  if (!hi.isEmpty()) img.addRepresentation({ scaleFactor: 2, buffer: hi.toPNG() })
  if (process.platform === 'darwin') img.setTemplateImage(false)
  return img
}

export interface TrayDeps {
  show(): void
  quit(): void
  presenceMode(): PresenceMode
  setPresenceMode(mode: PresenceMode): void
}

export class HiveTray {
  private tray?: Tray
  private count = 0

  constructor(private d: TrayDeps) {}

  create() {
    if (this.tray) return
    this.tray = new Tray(trayImage(false))
    this.tray.on('click', () => this.d.show())
    this.tray.on('double-click', () => this.d.show())
    this.refresh()
  }

  setCount(count: number) {
    if (count === this.count) return
    const alertChanged = !!count !== !!this.count
    this.count = count
    if (alertChanged) this.tray?.setImage(trayImage(count > 0))
    this.refresh()
  }

  refresh() {
    if (!this.tray) return
    this.tray.setToolTip(this.count ? `Hive: ${this.count} session${this.count === 1 ? '' : 's'} need you` : 'Hive')
    const mode = this.d.presenceMode()
    const radio = (m: PresenceMode, label: string) => ({
      label,
      type: 'radio' as const,
      checked: mode === m,
      click: () => {
        this.d.setPresenceMode(m)
        this.refresh()
      }
    })
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: this.count ? `Open Hive (${this.count} need you)` : 'Open Hive', click: () => this.d.show() },
        { type: 'separator' },
        radio('auto', 'Detect when I’m away'),
        radio('present', 'I’m at my desk'),
        radio('away', 'I’m away: send to phone'),
        { type: 'separator' },
        { label: 'Quit Hive', click: () => this.d.quit() }
      ])
    )
  }

  destroy() {
    this.tray?.destroy()
    this.tray = undefined
  }
}

export function appIcon(): NativeImage {
  return nativeImage.createFromPath(resourcePath('icon.png'))
}

export function supportsLoginItems(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
}

export function applyLoginItem(enabled: boolean) {
  if (!supportsLoginItems() || !app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
}
