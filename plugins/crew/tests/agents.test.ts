import { expect, test } from 'claude-code/testing'
import { CODEX_TOOL, EFFORTS, EFFORT_FLOOR, MODELS, MODEL_FLOORS, SPECIALISTS, codexSection, leadSection, offersCodex } from '../hooks/agents'

const by = (name: string) => SPECIALISTS.find(s => s.name === name)

test('each specialist runs on its model', () => {
  expect(by('code-reader')?.model).toBe('haiku')
  expect(by('research')?.model).toBe('haiku')
  expect(by('developer')?.model).toBe('sonnet')
  expect(by('designer')?.model).toBe('sonnet')
  expect(by('tester')?.model).toBe('sonnet')
  expect(by('architect')?.model).toBe('opus')
})

test('code reader cannot write and architect cannot edit', () => {
  expect(by('code-reader')?.tools).not.toContain('Edit')
  expect(by('code-reader')?.tools).not.toContain('Write')
  expect(by('architect')?.tools).toContain('Write')
  expect(by('architect')?.tools).not.toContain('Edit')
})

test('designer can edit and browse, tester can run commands', () => {
  expect(by('designer')?.tools).toContain('Edit')
  expect(by('designer')?.tools).toContain('mcp__claude-in-chrome__navigate')
  expect(by('tester')?.tools).toContain('Bash')
})

test('effort is set on purpose: every specialist defaults to medium, which is also the floor', () => {
  for (const s of SPECIALISTS) expect(s.effort).toBe('medium')
  expect(EFFORT_FLOOR).toBe('medium')
})

test('names are unique', () => {
  const names = SPECIALISTS.map(s => s.name)
  expect(new Set(names).size).toBe(names.length)
})

test('routing floors name real agents and tiers, and the architect never routes below opus', () => {
  for (const [name, floor] of Object.entries(MODEL_FLOORS)) {
    expect(by(name)).toBeDefined()
    expect(MODELS).toContain(floor)
    expect(MODELS.indexOf(by(name)!.model)).toBeGreaterThanOrEqual(MODELS.indexOf(floor))
  }
  expect(MODEL_FLOORS.architect).toBe('opus')
})

test('every default sits on the model and effort scales routing moves along', () => {
  for (const s of SPECIALISTS) {
    expect(MODELS).toContain(s.model)
    expect(EFFORTS).toContain(s.effort)
    expect(EFFORTS.indexOf(s.effort)).toBeGreaterThanOrEqual(EFFORTS.indexOf(EFFORT_FLOOR))
  }
})

test('codexSection names the three Codex tools', () => {
  const text = codexSection()
  expect(text.length).toBeGreaterThan(0)
  for (const name of ['mcp__crew__codex', 'mcp__crew__codex_result', 'mcp__crew__codex_cancel']) {
    expect(text).toContain(name)
  }
})

test('offersCodex is true only when the Codex tool is listed', () => {
  expect(offersCodex(['Agent', CODEX_TOOL])).toBe(true)
  expect(offersCodex(['Agent', 'mcp__crew__codex_result'])).toBe(false)
  expect(offersCodex([])).toBe(false)
})

test('leadSection does not carry the Codex text', () => {
  for (const jev of [true, false]) {
    expect(leadSection(jev)).not.toContain('codex')
    expect(leadSection(jev)).toBe(leadSection(jev))
  }
})
