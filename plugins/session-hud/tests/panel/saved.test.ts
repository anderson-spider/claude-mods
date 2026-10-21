import { expect, test } from 'claude-code/testing'
import type { SessionHudPanel } from '../../types'
import { ZERO } from '../../hooks/panel/agents'
import { PANEL_SHAPE, SAVED_MAX, SAVED_TTL_MS, pruned, restorable, savedKey, toSave } from '../../hooks/panel/saved'

const PANEL: SessionHudPanel = { agents: [{ id: 'a1', type: 'Explore', status: 'done', startedAt: 0, endedAt: 5, usage: ZERO, requests: 0 }], main: { usage: ZERO, turns: [[0, 5]] } }
const EMPTY: SessionHudPanel = { agents: [], main: { usage: ZERO, turns: [] } }

test('a panel with agents or turns is saved under its session, with when; an empty one is not', () => {
  expect(savedKey('s1')).toBe('panel:s1')
  expect(toSave(PANEL, 10)).toEqual({ shape: PANEL_SHAPE, panel: PANEL, savedAt: 10 })
  expect(toSave(EMPTY, 10)).toBeUndefined()
})

test('a stored value comes back only as a panel of this shape saved within the TTL, its malformed agents dropped', () => {
  const saved = (over: object = {}) => ({ shape: PANEL_SHAPE, panel: PANEL, savedAt: 1, ...over })
  expect(restorable(saved(), 2)).toEqual(PANEL)
  expect(restorable(saved({ shape: 'session-hud/panel/0' }), 2)).toBeUndefined()
  expect(restorable(saved({ panel: { agents: [] } }), 2)).toBeUndefined()
  expect(restorable(saved({ panel: { ...PANEL, agents: [...PANEL.agents, { id: 3 }] } }), 2)).toEqual(PANEL)
  expect(restorable(saved(), 1 + SAVED_TTL_MS + 1)).toBeUndefined()
  expect(restorable('junk', 2)).toBeUndefined()
  expect(restorable(undefined, 2)).toBeUndefined()
})

test('pruning drops stale, broken, older-shape and surplus panels and leaves other keys alone', () => {
  const now = SAVED_TTL_MS * 2
  const fresh = Array.from({ length: SAVED_MAX + 2 }, (_, i) => [`panel:f${i}`, { shape: PANEL_SHAPE, panel: PANEL, savedAt: now - i }] as [string, unknown])
  const entries: [string, unknown][] = [
    ['other', 1], ['panel:old', { shape: PANEL_SHAPE, panel: PANEL, savedAt: now - SAVED_TTL_MS - 1 }], ['panel:bad', { shape: PANEL_SHAPE, savedAt: now }],
    ['panel:older-shape', { shape: 'session-hud/panel/0', panel: PANEL, savedAt: now }], ...fresh,
  ]
  expect(pruned(entries, now)).toEqual(['panel:old', 'panel:bad', 'panel:older-shape', `panel:f${SAVED_MAX}`, `panel:f${SAVED_MAX + 1}`])
})
