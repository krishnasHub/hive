import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '../../shared/types'
import { attentionMap, newlyNeedingAttention } from '../attention'

const s = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  shortCode: 'A2B',
  title: id,
  cwd: '/',
  status: 'idle',
  createdAt: 0,
  lastActivityAt: 0,
  ...over
})

describe('attentionMap', () => {
  it('counts waiting sessions and unseen finished turns', () => {
    const m = attentionMap(
      [s('a', { status: 'waiting_permission' }), s('b', { lastActivityAt: 10_000 }), s('c', { status: 'working' }), s('d', { lastActivityAt: 10_000 })],
      null,
      true,
      { d: 10_000 }
    )
    expect([...m]).toEqual([
      ['a', 'needs_you'],
      ['b', 'update']
    ])
  })

  it('ignores the tab you are looking at, but only while the window is focused', () => {
    const list = [s('a', { status: 'waiting_input' })]
    expect(attentionMap(list, 'a', true, {}).size).toBe(0)
    expect(attentionMap(list, 'a', false, {}).size).toBe(1)
  })

  it('a freshly started session is not an update', () => {
    expect(attentionMap([s('a', { lastActivityAt: 1500 })], null, true, {}).size).toBe(0)
  })
})

describe('newlyNeedingAttention', () => {
  it('reports only new entries, preferring needs_you', () => {
    const prev = new Map([['a', 'update' as const]])
    expect(newlyNeedingAttention(prev, new Map([['a', 'update']]))).toBeNull()
    expect(newlyNeedingAttention(prev, new Map([['a', 'update'], ['b', 'update']]))).toBe('update')
    expect(newlyNeedingAttention(prev, new Map([['a', 'needs_you'], ['b', 'update']]))).toBe('needs_you')
  })
})
