import { test, expect } from 'claude-code/testing'
import { gateContext, gateMessage, type GateEvent } from '../hooks/gate'
import { rulesVerdict, type EditContext, type Verdict } from '../hooks/decisions'

const env = { root: '/repo', home: '/home/person', uid: '501' }
const edit: GateEvent = { tool: 'Edit', file_path: '/repo/src/main.ts', old_string: 'old', new_string: 'new' }
const context = (e: GateEvent): EditContext => {
  const result = gateContext(e, env)
  if (result.skip) throw new Error(result.why)
  return result.ctx
}

test('subagent calls pass without mutating the event', () => {
  const e = Object.freeze({ ...edit, agentId: 'worker' })
  expect(gateContext(e, env).skip).toBe(true)
  expect(e).toEqual({ ...edit, agentId: 'worker' })
})

for (const tool of ['Read', 'Bash', 'Unknown']) {
  test(`${tool} is outside the gated tool set`, () => {
    expect(gateContext({ ...edit, tool }, env).skip).toBe(true)
  })
}

for (const file_path of ['/repo/.pantheon/plans/plan.md', '/home/person/.claude/plans/note.md', '/home/person/.claude/projects/repo/memory/note.md', '/tmp/claude-501/repo/session/scratchpad/note.md', '/private/tmp/claude-501/repo/session/scratchpad/note.md', '.pantheon/plans/plan.md']) {
  test(`exempts ${file_path}`, () => {
    expect(gateContext({ ...edit, file_path }, env).skip).toBe(true)
  })
}

// `.pantheon/flow/**` holds the flows and the state the Stop trusts: never exempt, and never a change the rules call
// trivial, however small (an unknown size is an ask). Only the plans are exempt from `.pantheon`.
for (const file_path of [
  '/repo/.pantheon/flow/demo/approved.json', '/repo/.pantheon/flow/demo/state.json', '/repo/.pantheon/flow/active', '/repo/.pantheon/flow/active.json',
  '.pantheon/flow/demo/journal.jsonl', '/repo/.PANTHEON/Flow/demo/approved.json', '/repo/.pantheon/plans/../flow/demo/approved.json', '/repo/.pantheon/flow',
]) {
  test(`does not exempt the flow's own file ${file_path} and asks even for a one-line change`, () => {
    const result = gateContext({ ...edit, file_path }, env)
    expect(result.skip).toBe(false)
    if (!result.skip) {
      expect(result.ctx.linesAdded).toBeUndefined()
      expect(result.ctx.linesRemoved).toBeUndefined()
      expect(rulesVerdict(result.ctx).action).toBe('ask')
    }
    const write = gateContext({ tool: 'Write', file_path, content: '{}' }, env)
    expect(write.skip).toBe(false)
    if (!write.skip) expect(rulesVerdict(write.ctx).action).toBe('ask')
  })
}

for (const file_path of ['/repo/.pantheon/plan.md', '/repo/.pantheon/notes/a.md', '/repo/.pantheon/flows/a.json', '.pantheon/plan.md']) {
  test(`only .pantheon/plans is exempt from .pantheon: ${file_path} is judged by the rules`, () => {
    const result = gateContext({ ...edit, file_path }, env)
    expect(result.skip).toBe(false)
    if (!result.skip) expect(rulesVerdict(result.ctx).action).toBe('allow')
  })
}

for (const file_path of ['/repo/.pantheon/../main.ts', '/tmp/session/../main.ts', '/home/person/.claude/../main.ts', '/repo/.pantheon-other/main.ts', '/tmp/session-other/main.ts', '/home/person/.claude-other/main.ts']) {
  test(`does not exempt an escaped path or prefix sibling: ${file_path}`, () => {
    expect(gateContext({ ...edit, file_path }, env).skip).toBe(false)
  })
}

test('normalizes paths before checking exemptions and injected roots', () => {
  expect(gateContext({ ...edit, file_path: '/repo/src/../.pantheon/plans/plan.md' }, env).skip).toBe(true)
  expect(gateContext({ ...edit, file_path: '/repo/.pantheon/plans/plan.md' }, { ...env, root: '/repo/./' }).skip).toBe(true)
  expect(gateContext({ ...edit, file_path: '/tmp/session/note.txt' }, { root: env.root, home: env.home }).skip).toBe(false)
})

for (const file_path of [
  '/home/person/.claude/settings.json', '/home/person/.claude/CLAUDE.md', '/home/person/.claude/hooks/a.ts',
  '/home/person/.claude/mods/a.ts', '/home/person/.claude/skills/a.ts', '/home/person/.claude/plugins/a.ts',
  '/home/person/.claude/projects/repo/settings.json', '/home/person/.claude/projects/repo/nested/memory/a.md',
  '/home/person/.claude/plans-other/a.md', '/home/person/.claude/projects/repo/memory-other/a.md',
  '/tmp/claude-502/repo/session/scratchpad/a.ts', '/private/tmp/claude-502/repo/session/scratchpad/a.ts',
  '/tmp/claude-501/a.ts', '/tmp/claude-501/session/scratchpad/a.ts', '/tmp/claude-501/a/b/c/scratchpad/a.ts',
  '/tmp/claude-501/repo/session/scratchpad/../a.ts',
]) {
  test(`does not exempt privileged state or a non-session scratchpad: ${file_path}`, () => {
    expect(gateContext({ ...edit, file_path }, env).skip).toBe(false)
  })
}

test('without a verified uid no scratchpad is exempt', () => {
  expect(gateContext({ ...edit, file_path: '/tmp/claude-501/repo/session/scratchpad/a.ts' }, { root: env.root, home: env.home }).skip).toBe(false)
})

test('uses relative normalized paths inside the root and absolute paths outside', () => {
  expect(context({ ...edit, file_path: 'src/../src/main.ts' })).toEqual({ tool: 'Edit', path: 'src/main.ts', ext: '.ts', linesAdded: 1, linesRemoved: 1, files: 1 })
  expect(context({ ...edit, file_path: '/repo-other/main.ts' }).path).toBe('/repo-other/main.ts')
  expect(context({ ...edit, file_path: '../other/main.ts' }).path).toBe('/other/main.ts')
  expect(context({ ...edit, file_path: 'Makefile' }).ext).toBe('')
  expect(context({ ...edit, file_path: '.env' }).ext).toBe('')
})

for (const [value, count] of [['', 0], ['one', 1], ['one\n', 1], ['one\ntwo', 2], ['one\ntwo\n', 2], ['\n', 1], ['one\n\n', 2]] as const) {
  test(`Edit counts ${JSON.stringify(value)}`, () => {
    expect(context({ ...edit, old_string: value, new_string: value })).toMatchObject({ linesAdded: count, linesRemoved: count })
  })
}

test('replace_all leaves both counts unknown', () => {
  const ctx = context({ ...edit, replace_all: true })
  expect(ctx.linesAdded).toBeUndefined()
  expect(ctx.linesRemoved).toBeUndefined()
})

for (const [tool, pathField, sourceField] of [['Write', 'file_path', 'content'], ['NotebookEdit', 'notebook_path', 'new_source']] as const) {
  test(`${tool} uses its real input fields and cannot know removed lines`, () => {
    const ctx = context({ tool, [pathField]: '/repo/file.ipynb', [sourceField]: 'one\ntwo\n' })
    expect(ctx).toMatchObject({ tool, path: 'file.ipynb', ext: '.ipynb', files: 1, linesAdded: 2 })
    expect(ctx.linesRemoved).toBeUndefined()
    expect(context({ tool, [pathField]: '/repo/file', [sourceField]: '' }).linesAdded).toBe(0)
    for (const source of [undefined, null, 42]) {
      expect(context({ tool, [pathField]: '/repo/file', [sourceField]: source }).linesAdded).toBeUndefined()
    }
  })
}

test('missing or non-string Edit fields keep counts unknown', () => {
  for (const value of [undefined, null, 42]) {
    const ctx = context({ ...edit, old_string: value, new_string: value })
    expect(ctx.linesAdded).toBeUndefined()
    expect(ctx.linesRemoved).toBeUndefined()
  }
  expect(context({ tool: 'Edit' })).toMatchObject({ path: '', ext: '', files: 1 })
})

for (const action of ['allow', 'ask', 'deny'] as const) {
  for (const developer of [false, true]) {
    for (const ux of [false, true]) {
      test(`message: ${action}, developer=${developer}, ux=${ux}`, () => {
        const verdict: Verdict = { action, reason: 'Decision reason.' }
        const message = gateMessage(verdict, { developer, ux })
        expect(message).toContain('by rules')
        if (action === 'allow') {
          expect(message).toContain('Allowed')
        } else {
          expect(message).toContain(action === 'deny' ? 'Denied' : 'Ask')
          expect(message.split('\n').length).toBeGreaterThanOrEqual(2)
          expect(message.split('\n').length).toBeLessThanOrEqual(3)
          expect(message).toContain('main session should not edit it itself')
          // Code goes to developer and visual work to ux; a disabled role is not recommended.
          expect(message.includes('delegate to developer')).toBe(developer)
          expect(message.includes('ux')).toBe(ux)
          expect(message.includes('ask the person')).toBe(!developer)
        }
      })
    }
  }
}

test('the message names developer for code and ux for visual work', () => {
  const verdict: Verdict = { action: 'deny', reason: '' }
  expect(gateMessage(verdict, { developer: true, ux: true })).toContain('delegate to developer (code) or ux (visual work)')
  expect(gateMessage(verdict, { developer: true, ux: false })).toContain('Please delegate to developer;')
  expect(gateMessage(verdict, { developer: false, ux: true })).toContain('ask the person to handle implementation; delegate visual work to ux')
})

test('a 3000-line Write is denied by the size rule although removed lines are unknown', () => {
  const ctx = context({ tool: 'Write', file_path: '/repo/src/big.ts', content: 'line\n'.repeat(3000) })
  expect(ctx.linesAdded).toBe(3000)
  expect(ctx.linesRemoved).toBeUndefined()
  expect(rulesVerdict(ctx).action).toBe('deny')
})
