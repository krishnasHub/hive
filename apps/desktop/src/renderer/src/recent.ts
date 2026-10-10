// Recently used project folders (per-device convenience, so localStorage is fine).
const KEY = 'hive.recentFolders'

export function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function saveRecent(dir: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify([dir, ...loadRecent().filter((d) => d !== dir)].slice(0, 12)))
  } catch {
    /* storage unavailable */
  }
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}
