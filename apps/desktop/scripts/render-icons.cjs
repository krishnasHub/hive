// Renders build/icon.svg to the PNGs the app and installers need. Run: npx electron scripts/render-icons.cjs
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8')
// Tray "needs you" variant: same icon with a red dot.
const alertSvg = svg.replace('</svg>', '<circle cx="404" cy="108" r="96" fill="#E5343F" stroke="#0C0C0C" stroke-width="20"/></svg>')

async function render(markup, size) {
  const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } })
  win.webContents.setZoomFactor(1)
  const html = `<html><body style="margin:0;background:transparent">${markup.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 300))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
  win.destroy()
  return img.resize({ width: size, height: size, quality: 'best' })
}

app.on('window-all-closed', () => {}) // keep running between renders

app.whenReady().then(async () => {
  // Render each design once, large, and downscale; Chromium sometimes refuses back-to-back data: loads.
  const big = await render(svg, 1024)
  const alert = await render(alertSvg, 1024)
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), big.toPNG())
  const res = path.join(root, 'resources')
  fs.mkdirSync(res, { recursive: true })
  const down = (img, s) => img.resize({ width: s, height: s, quality: 'best' }).toPNG()
  fs.writeFileSync(path.join(res, 'icon.png'), down(big, 256))
  for (const s of [16, 32]) {
    fs.writeFileSync(path.join(res, `tray-${s}.png`), down(big, s))
    fs.writeFileSync(path.join(res, `tray-alert-${s}.png`), down(alert, s))
  }
  console.log('icons written')
  app.quit()
})
