import { expect, test } from 'claude-code/testing'
import type { CommandInfo } from 'claude-code'
import type { SessionHudSteps } from '../types'
import { HIDDEN, MAX_STEPS, MIN_ANSWER_CHARS, clean, earnsSteps, forkPrompt, isCommand, offered, parseSteps, skillList } from '../hooks/steps'

test('a step keeps only what a person can see: no escapes, controls or hidden tags, cut with … at its length', () => {
  expect(clean('\x1b[31mred\x1b[0m\tand​then\n  more', 40)).toBe('red andthen more')
  expect(clean('ignore\u{E0041}\u{E0042} this', 40)).toBe('')
  expect(clean('abcdefghij', 5)).toBe('abcd…')
  expect(clean('á́́́́', 10)).toBe('á́́')
})

test('the fork reads plugin, user and MCP commands with their descriptions, never the engine ones', () => {
  const commands: CommandInfo[] = [
    { name: 'clear', description: 'Clear', source: 'builtin' },
    { name: 'code-review', description: 'Review\x1b[2J the diff', source: 'plugin' },
    { name: 'bad​name', description: 'Hidden', source: 'user' },
  ]
  expect(skillList(commands)).toBe('/code-review: Review the diff')
  expect(forkPrompt('/code-review: Review the diff')).toContain('<available-skills>\n/code-review: Review the diff\n</available-skills>')
  expect(forkPrompt('')).not.toContain('<available-skills>')
  expect(forkPrompt('')).toContain(`up to ${MAX_STEPS} concrete prompts`)
})

test('the reply is read as a JSON array around any prose; a missing label takes the prompt, an unknown command is dropped', () => {
  const reply = 'Sure:\n[{"label":"Run tests","prompt":"Run npm test"},{"prompt":"Open a PR for this branch"},{"label":"x","prompt":"/made-up go"},{"label":"Review","prompt":"/code-review high"},{"label":7}]'
  expect(parseSteps(reply, new Set(['code-review']))).toEqual([
    { label: 'Run tests', prompt: 'Run npm test' },
    { label: 'Open a PR for this branch', prompt: 'Open a PR for this branch' },
    { label: 'Review', prompt: '/code-review high' },
  ])
  // Without the command list a slash prompt goes unchecked.
  expect(parseSteps('[{"label":"x","prompt":"/made-up go"}]', null)).toEqual([{ label: 'x', prompt: '/made-up go' }])
  expect(parseSteps('no list here', null)).toEqual([])
  expect(parseSteps('[not json]', null)).toEqual([])
  const many = JSON.stringify(Array.from({ length: MAX_STEPS + 2 }, (_, i) => ({ label: `s${i}`, prompt: `p${i}` })))
  expect(parseSteps(many, null).length).toBe(MAX_STEPS)
})

test('only a full answer of some length earns steps', () => {
  expect(earnsSteps('answer', 'x'.repeat(MIN_ANSWER_CHARS))).toBe(true)
  expect(earnsSteps('answer', 'thanks!')).toBe(false)
  expect(earnsSteps('aborted', 'x'.repeat(MIN_ANSWER_CHARS))).toBe(false)
})

test('a fork offers its steps only for the turn it was asked after, and none hides the section', () => {
  const loading: SessionHudSteps = { kind: 'loading', turnId: 't1' }
  const steps = [{ label: 'a', prompt: 'do a' }]
  expect(offered(loading, 't1', steps)).toEqual({ kind: 'offer', steps })
  expect(offered(loading, 't1', [])).toEqual(HIDDEN)
  expect(offered(loading, 't0', steps)).toBe(loading)
  expect(offered(HIDDEN, 't1', steps)).toBe(HIDDEN)
})

