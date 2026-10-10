import { test, expect } from 'claude-code/testing'
import { gateContext, gateMessage, type GateEvent } from '../hooks/gate'
import type { EditContext, Verdict } from '../hooks/decisions'

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

for (const file_path of ['/repo/.pantheon/plan.md', '/home/person/.claude/plans/note.md', '/home/person/.claude/projects/repo/memory/note.md', '/tmp/claude-501/repo/session/scratchpad/note.md', '/private/tmp/claude-501/repo/session/scratchpad/note.md', '.pantheon/plan.md']) {
  test(`exempts ${file_path}`, () => {
    expect(gateContext({ ...edit, file_path }, env).skip).toBe(true)
  })
}

for (const file_path of ['/repo/.pantheon/../main.ts', '/tmp/session/../main.ts', '/home/person/.claude/../main.ts', '/repo/.pantheon-other/main.ts', '/tmp/session-other/main.ts', '/home/person/.claude-other/main.ts']) {
  test(`does not exempt an escaped path or prefix sibling: ${file_path}`, () => {
    expect(gateContext({ ...edit, file_path }, env).skip).toBe(false)
  })
}

test('normalizes paths before checking exemptions and injected roots', () => {
  expect(gateContext({ ...edit, file_path: '/repo/src/../.pantheon/plan.md' }, env).skip).toBe(true)
  expect(gateContext({ ...edit, file_path: '/repo/.pantheon/plan.md' }, { ...env, root: '/repo/./' }).skip).toBe(true)
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
  for (const source of ['jev', 'rules'] as const) {
    for (const executor of [false, true]) {
      for (const designer of [false, true]) {
        test(`message: ${action}, ${source}, executor=${executor}, designer=${designer}`, () => {
          const verdict: Verdict = { action, source, score: source === 'jev' ? 0.42 : undefined, reason: 'Decision reason.' }
          const message = gateMessage(verdict, { ...context(edit), path: 'src/view.tsx', ext: '.tsx' }, { executor, designer })
          expect(message).toContain(source)
          if (source === 'jev') expect(message).toContain('0.42')
          if (action === 'allow') {
            expect(message).toContain('Allowed')
          } else {
            expect(message).toContain(action === 'deny' ? 'Denied' : 'Ask')
            expect(message.split('\n').length).toBeGreaterThanOrEqual(2)
            expect(message.split('\n').length).toBeLessThanOrEqual(3)
            expect(message).toContain('main session should not edit it itself')
            expect(message.includes('executor')).toBe(executor)
            expect(message.includes('designer')).toBe(designer)
            if (!executor || !designer) expect(message).toContain('ask the person')
          }
        })
      }
    }
  }
}

for (const ext of ['.tsx', '.jsx', '.css', '.scss', '.svelte', '.vue', '.html', '.ts']) {
  test(`designer routing for ${ext}`, () => {
    const message = gateMessage({ action: 'deny', source: 'rules', reason: '' }, { ...context(edit), path: `src/file${ext}`, ext }, { executor: true, designer: true })
    expect(message.includes('designer')).toBe(ext !== '.ts')
  })
}
