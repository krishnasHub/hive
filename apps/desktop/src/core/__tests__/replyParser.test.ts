import { describe, expect, it } from 'vitest'
import { extractSessionCode, parseReply } from '../replyParser'

describe('parseReply', () => {
  it('understands plain approvals and denials', () => {
    expect(parseReply('yes')).toEqual({ type: 'approve' })
    expect(parseReply(' Y ')).toEqual({ type: 'approve' })
    expect(parseReply('👍')).toEqual({ type: 'approve' })
    expect(parseReply('no')).toEqual({ type: 'deny' })
    expect(parseReply('stop')).toEqual({ type: 'stop' })
    expect(parseReply('status')).toEqual({ type: 'status' })
  })

  it('keeps instructions after yes/no', () => {
    expect(parseReply('yes, but skip seed data')).toEqual({ type: 'approve', followUp: 'skip seed data' })
    expect(parseReply('no - use the staging db instead')).toEqual({ type: 'deny', reason: 'use the staging db instead' })
    expect(parseReply('go ahead and then open a PR')).toEqual({ type: 'approve', followUp: 'open a PR' })
  })

  it('treats anything else as a prompt', () => {
    expect(parseReply('now open a PR')).toEqual({ type: 'text', text: 'now open a PR' })
    expect(parseReply('yesterday was fine')).toEqual({ type: 'text', text: 'yesterday was fine' })
  })

  it('button actions win over text', () => {
    expect(parseReply('', 'approve')).toEqual({ type: 'approve' })
    expect(parseReply('whatever', 'deny')).toEqual({ type: 'deny' })
  })
})

describe('extractSessionCode', () => {
  it('pulls a known code off the front', () => {
    expect(extractSessionCode('H7K: run tests', ['H7K'])).toEqual({ code: 'H7K', rest: 'run tests' })
    expect(extractSessionCode('h7k run tests', ['H7K'])).toEqual({ code: 'H7K', rest: 'run tests' })
    expect(extractSessionCode('[H7K] yes', ['H7K'])).toEqual({ code: 'H7K', rest: 'yes' })
  })

  it('ignores unknown codes and normal words', () => {
    expect(extractSessionCode('yes please', ['H7K'])).toEqual({ rest: 'yes please' })
    expect(extractSessionCode('A2B: hi', ['H7K'])).toEqual({ rest: 'A2B: hi' })
  })
})
