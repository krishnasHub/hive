// Draws the red count bubble used as the Windows taskbar overlay icon.
const cache = new Map<string, string>()

export function badgeDataUrl(count: number): string {
  const label = count > 9 ? '9+' : String(count)
  const hit = cache.get(label)
  if (hit) return hit
  const size = 32
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  g.fillStyle = '#e5343f'
  g.beginPath()
  g.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = '#ffffff'
  g.font = `bold ${label.length > 1 ? 17 : 21}px "Segoe UI", system-ui, sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(label, size / 2, size / 2 + 1)
  const url = c.toDataURL('image/png')
  cache.set(label, url)
  return url
}
