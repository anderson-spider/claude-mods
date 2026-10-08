import { describe, expect, test } from 'claude-code/testing'
import { DEFAULT_CONFIG } from '../hooks/defaults'
import { buildOrchestratorSection } from '../hooks/prompts/orchestrator'
import { buildCouncilBlock, isCouncilOrigin, matchesCouncilTrigger } from '../hooks/prompts/council'

describe('council triggers', () => {
  for (const text of ['run a council', '@council', '@councillor-alpha', 'second opinion', 'second opinions', 'consensus', 'roundtable', 'multiple opinions', 'multiple models', 'several models', 'multi-model', 'quero consenso', 'segunda opinião', 'segunda opiniao', 'conselho', '共识']) {
    test(`recognizes ${text}`, () => expect(matchesCouncilTrigger(text)).toBe(true))
  }
  for (const text of ['', 'fix the build', 'alpha and beta', 'councilman', 'unconsensual', 'vote', 'conselheiro', '```json\n{"council": true}\n```', 'Use `council` in the config', '/help council', '  /council', '/ council', '/123 consensus', '~~~text\ncouncil\n~~~', '``council``', '```text\ncouncil']) {
    test(`ignores ${JSON.stringify(text)}`, () => expect(matchesCouncilTrigger(text)).toBe(false))
  }
  test('keeps prose triggers outside code without leaking fenced content', () => {
    expect(matchesCouncilTrigger('```\nhello\n```\nquero consenso')).toBe(true)
    expect(matchesCouncilTrigger('Use `council` later; now get a second opinion')).toBe(true)
    expect(matchesCouncilTrigger('~~~~\n```\ncouncil\n```\n~~~~')).toBe(false)
  })
  for (const text of ['Exemplo: `council\nconfig`', '> ```json\n> {"council":true}\n> ```', '> > ~~~text\n> > conselho\n> > ~~~', 'Example: ``a ` council\nconfig ` b``']) {
    test(`ignores quoted or multiline code ${JSON.stringify(text)}`, () => {
      expect(matchesCouncilTrigger(text)).toBe(false)
    })
  }
  test('preserves prose outside multiline spans and quoted fences', () => {
    expect(matchesCouncilTrigger('Example: `hello\nworld`\nsecond opinion')).toBe(true)
    expect(matchesCouncilTrigger('> ```json\n> {"council":true}\n> ```\nquero consenso')).toBe(true)
    expect(matchesCouncilTrigger('> ```text\n> sample\nquero consenso')).toBe(true)
  })
  test('origin allowlist excludes SDK, plugins and future origins', () => {
    expect(isCouncilOrigin('composer')).toBe(true)
    expect(isCouncilOrigin('bridge')).toBe(true)
    for (const kind of [undefined, 'sdk', 'plugin', 'pantheon', 'notification', 'peer', 'COMPOSER', '']) {
      expect(isCouncilOrigin(kind)).toBe(false)
    }
  })
})

describe('council block', () => {
  test('dispatches every seat by engine in background and preserves synthesis', () => {
    const block = buildCouncilBlock(DEFAULT_CONFIG)
    expect(block).toContain('delegate({ agent: "councillor:alpha", background: true')
    expect(block).toContain('Agent({ subagent_type: "pantheon:councillor-beta", run_in_background: true')
    for (const text of ['## Council Response', '## Per-Councillor Details', '## Council Summary', 'Consensus Level', 'unanimous', 'majority', 'split', 'Agreed Points', 'Disagreements', 'Remaining Uncertainty', 'Recommended Action']) {
      expect(block).toContain(text)
    }
  })
  test('fetches context first, retries empty results once and keeps all failures visible', () => {
    const block = buildCouncilBlock(DEFAULT_CONFIG)
    for (const text of ['FIRST', 'read-only', 'same turn', 'delegate_result', 'retry an empty seat once', 'failed', 'delegate_cancel', 'no fixed deadline', 'seat name', 'synthesize yourself']) {
      expect(block).toContain(text)
    }
    expect(block).not.toContain('3 minutes')
    expect(block).not.toContain('agent: "council"')
  })
  test('renders arbitrary seats deterministically without default-seat leftovers', () => {
    const config = { ...DEFAULT_CONFIG, council: { seats: { zeta: { engine: 'claude' as const }, gamma: { engine: 'codex' as const } } } }
    const block = buildCouncilBlock(config)
    expect(block).toContain('councillor:gamma')
    expect(block).toContain('pantheon:councillor-zeta')
    expect(block).not.toContain('alpha')
    expect(block).not.toContain('beta')
    expect(block).toBe(buildCouncilBlock(config))
  })
  test('disabled council has no block or seat line', () => {
    const config = { ...DEFAULT_CONFIG, disabledAgents: ['council'] }
    expect(buildCouncilBlock(config)).toBe('')
    expect(buildOrchestratorSection(config)).not.toContain('councillor')
  })
  test('no seats means no procedure to dispatch', () => {
    expect(buildCouncilBlock({ ...DEFAULT_CONFIG, council: { seats: {} } })).toBe('')
  })
})

test('disabled seat is left out of the dispatch and the orchestrator line', () => {
  const config = { ...DEFAULT_CONFIG, disabledAgents: ['councillor:alpha'] }
  const block = buildCouncilBlock(config)
  expect(block).not.toContain('councillor:alpha')
  expect(block).toContain('pantheon:councillor-beta')
  expect(buildOrchestratorSection(config)).not.toContain('councillor:alpha')
})
