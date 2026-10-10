// Extracts searchable text from Claude Code transcript lines (~/.claude/projects/<project>/<session>.jsonl).

export interface TranscriptMessage {
  sessionId: string
  role: 'user' | 'assistant'
  ts: string
  cwd?: string
  text: string
}

const MAX_TEXT = 8000

function blocksToText(content: unknown, role: 'user' | 'assistant'): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out: string[] = []
  for (const b of content) {
    if (!b || typeof b !== 'object') continue
    const block = b as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    else if (role === 'assistant' && block.type === 'tool_use') {
      // Keep the gist of tool calls (commands, paths) so they are findable.
      const input = (block.input ?? {}) as Record<string, unknown>
      const gist = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description
      if (typeof gist === 'string') out.push(`[${String(block.name)}] ${gist}`)
    }
  }
  return out.join('\n')
}

/** Drops injected system text that would otherwise dominate search results. */
function cleanUserText(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g, '')
    .trim()
}

export function parseTranscriptLine(line: string): TranscriptMessage | null {
  if (!line || line[0] !== '{') return null
  let o: Record<string, unknown>
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  const type = o.type
  if (type !== 'user' && type !== 'assistant') return null
  if (o.isMeta || o.isSidechain) return null
  const message = o.message as { content?: unknown } | undefined
  if (!message) return null
  let text = blocksToText(message.content, type)
  if (type === 'user') text = cleanUserText(text)
  text = text.trim()
  if (!text) return null
  return {
    sessionId: String(o.sessionId ?? ''),
    role: type,
    ts: String(o.timestamp ?? ''),
    cwd: typeof o.cwd === 'string' ? o.cwd : undefined,
    text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text
  }
}

/** Turns free text into a safe FTS5 query: every word must match (prefix match on the last). */
export function toFtsQuery(input: string): string {
  const terms = input
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter(Boolean)
    .slice(0, 12)
  if (!terms.length) return ''
  return terms.map((t, i) => `"${t}"${i === terms.length - 1 ? '*' : ''}`).join(' ')
}
