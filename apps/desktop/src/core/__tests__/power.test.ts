import { describe, expect, it } from 'vitest'
import { decide, engagedValues, lidSetCommands, parseLidQuery, parseLidState, LIDACTION, SUB_BUTTONS } from '../power'

const ENGLISH = `Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)
  GUID Alias: SCHEME_BALANCED
  Subgroup GUID: 4f971e89-eebd-4455-a8de-9e59040e7347  (Power buttons and lid)
    GUID Alias: SUB_BUTTONS
    Power Setting GUID: 5ca83367-6e45-459f-a27b-476b1d01c936  (Lid close action)
      GUID Alias: LIDACTION
      Possible Setting Index: 000
      Possible Setting Friendly Name: Do nothing
      Possible Setting Index: 001
      Possible Setting Friendly Name: Sleep
      Possible Setting Index: 002
      Possible Setting Friendly Name: Hibernate
      Possible Setting Index: 003
      Possible Setting Friendly Name: Shut down
    Current AC Power Setting Index: 0x00000001
    Current DC Power Setting Index: 0x00000002
`

const GERMAN = `GUID des Energieschemas: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (Höchstleistung)
  GUID-Alias: SCHEME_MIN
  GUID der Untergruppe: 4f971e89-eebd-4455-a8de-9e59040e7347  (Netzschalter und Zuklappen)
    GUID-Alias: SUB_BUTTONS
    GUID der Energieeinstellung: 5ca83367-6e45-459f-a27b-476b1d01c936  (Zuklappen)
      GUID-Alias: LIDACTION
      Möglicher Einstellungsindex: 000
      Angezeigter Name der möglichen Einstellung: Nichts unternehmen
      Möglicher Einstellungsindex: 001
      Angezeigter Name der möglichen Einstellung: Energie sparen
    Index der aktuellen Wechselstromeinstellung: 0x00000003
    Index der aktuellen Gleichstromeinstellung: 0x00000001
`

const NO_LID = `Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)
  GUID Alias: SCHEME_BALANCED
`

describe('parseLidQuery', () => {
  it('reads the scheme and AC/DC values', () => {
    expect(parseLidQuery(ENGLISH)).toEqual({ scheme: '381b4222-f694-41f0-9685-ff5bb260df2e', ac: 1, dc: 2 })
  })

  it('does not depend on English labels', () => {
    expect(parseLidQuery(GERMAN)).toEqual({ scheme: '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c', ac: 3, dc: 1 })
  })

  it('returns null when the machine has no lid setting', () => {
    expect(parseLidQuery(NO_LID)).toBeNull()
    expect(parseLidQuery('')).toBeNull()
  })

  it('handles CRLF output', () => {
    expect(parseLidQuery(ENGLISH.replace(/\n/g, '\r\n'))?.dc).toBe(2)
  })
})

describe('decide', () => {
  const on = (lidClosed: 'off' | 'plugged-in' | 'always') => ({ keepAwake: true, lidClosed })

  it('does nothing without active sessions or with keepAwake off', () => {
    expect(decide(0, on('always'), false, 'win32')).toEqual({ blockIdle: false, lid: 'none' })
    expect(decide(3, { keepAwake: false, lidClosed: 'always' }, false, 'win32')).toEqual({ blockIdle: false, lid: 'none' })
  })

  it('blocks idle sleep only when lid mode is off', () => {
    expect(decide(1, on('off'), false, 'win32')).toEqual({ blockIdle: true, lid: 'none' })
  })

  it('Windows: AC index for plugged-in, both for always, regardless of battery', () => {
    expect(decide(1, on('plugged-in'), true, 'win32').lid).toBe('ac')
    expect(decide(1, on('always'), true, 'win32').lid).toBe('ac+dc')
  })

  it('Linux: inhibit, but only on AC power for plugged-in', () => {
    expect(decide(1, on('plugged-in'), false, 'linux').lid).toBe('inhibit')
    expect(decide(1, on('plugged-in'), true, 'linux')).toEqual({ blockIdle: true, lid: 'none' })
    expect(decide(1, on('always'), true, 'linux').lid).toBe('inhibit')
  })

  it('macOS: never overrides the lid', () => {
    expect(decide(2, on('always'), false, 'darwin')).toEqual({ blockIdle: true, lid: 'none' })
  })
})

describe('lid state and commands', () => {
  it('round-trips the saved state and rejects junk', () => {
    const st = { platform: 'win32', scheme: '381b4222-f694-41f0-9685-ff5bb260df2e', ac: 1, dc: 1, mode: 'ac' }
    expect(parseLidState(JSON.stringify(st))).toEqual(st)
    expect(parseLidState('{')).toBeNull()
    expect(parseLidState(JSON.stringify({ ...st, scheme: 'x & del' }))).toBeNull()
    expect(parseLidState(JSON.stringify({ ...st, platform: 'linux' }))).toBeNull()
  })

  it('keeps the DC value unless the mode is always', () => {
    const orig = { scheme: 's', ac: 1, dc: 2 }
    expect(engagedValues(orig, 'ac')).toEqual({ ac: 0, dc: 2 })
    expect(engagedValues(orig, 'ac+dc')).toEqual({ ac: 0, dc: 0 })
  })

  it('builds powercfg commands for the saved scheme', () => {
    expect(lidSetCommands('g', 0, 2)).toEqual([
      ['/setacvalueindex', 'g', SUB_BUTTONS, LIDACTION, '0'],
      ['/setdcvalueindex', 'g', SUB_BUTTONS, LIDACTION, '2'],
      ['/setactive', 'SCHEME_CURRENT']
    ])
  })
})
