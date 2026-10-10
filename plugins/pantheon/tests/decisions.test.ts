import { test, expect } from 'claude-code/testing'
import { rulesVerdict, type EditContext } from '../hooks/decisions'

const ctx: EditContext = { tool: 'Edit', path: 'src/user.ts', ext: '.ts', linesAdded: 1, linesRemoved: 0, files: 1 }

const battery: [string, Partial<EditContext>, string][] = [
  ['README typo', { path: 'README.md', ext: '.md' }, 'allow'],
  ['one-line bugfix', {}, 'allow'],
  ['doc paragraph', { path: 'AGENTS.md', ext: '.md', linesAdded: 8 }, 'allow'],
  ['tests update', { path: 'tests/user.test.ts', files: 2, linesAdded: 40 }, 'ask'],
  ['CI workflow', { path: '.github/workflows/ci.yml', ext: '.yml', linesAdded: 12 }, 'ask'],
  ['DB migration', { path: 'db/migrations/0042_users.sql', ext: '.sql', linesAdded: 30 }, 'ask'],
  ['new module', { files: 3, linesAdded: 220 }, 'deny'],
  ['rename across codebase', { files: 14, linesAdded: 60 }, 'deny'],
  ['sed across files', { tool: 'Bash', files: 25, linesAdded: undefined, linesRemoved: undefined }, 'deny'],
  ['core class refactor', { files: 5, linesAdded: 180 }, 'deny'],
]
for (const [name, input, action] of battery) {
  test(`local rules: ${name}`, () => {
    expect(rulesVerdict({ ...ctx, ...input })).toMatchObject({ action })
  })
}

for (const path of ['.github/workflows/ci.yml', 'db/migrate/42.sql', 'migrations/42.sql', 'package.json', 'nested/plugin.json', '.claude-plugin/marketplace.json', 'deps.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Cargo.lock']) {
  test(`sensitive path asks even for one changed line: ${path}`, () => {
    expect(rulesVerdict({ ...ctx, path }).action).toBe('ask')
  })
}

test('local rules count added and removed lines and preserve unknowns', () => {
  expect(rulesVerdict({ ...ctx, linesAdded: 3, linesRemoved: 2 }).action).toBe('allow')
  expect(rulesVerdict({ ...ctx, linesAdded: 3, linesRemoved: 3 }).action).toBe('ask')
  expect(rulesVerdict({ ...ctx, linesRemoved: undefined }).action).toBe('ask')
  expect(rulesVerdict({ ...ctx, files: 3, linesAdded: 50, linesRemoved: 50 }).action).toBe('ask')
  expect(rulesVerdict({ ...ctx, files: 3, linesAdded: 51, linesRemoved: 50 }).action).toBe('deny')
  for (const ext of ['.md', '.mdx', '.txt', '.rst']) {
    expect(rulesVerdict({ ...ctx, ext, linesAdded: 20 }).action).toBe('allow')
    expect(rulesVerdict({ ...ctx, ext, linesAdded: 21 }).action).toBe('ask')
    expect(rulesVerdict({ ...ctx, ext, files: 4, linesAdded: 1 }).action).toBe('deny')
  }
})

test('deny reasons point to developer', () => {
  expect(rulesVerdict({ ...ctx, linesAdded: 400, linesRemoved: 0 }).reason).toBe('Large or multi-file change; delegate to developer.')
  expect(rulesVerdict({ ...ctx, files: 5 }).reason).toBe('Large or multi-file change; delegate to developer.')
})

test('a Write of thousands of lines is denied by size even though removed lines are unknown', () => {
  const write: EditContext = { tool: 'Write', path: 'src/big.ts', ext: '.ts', linesAdded: 3000, linesRemoved: undefined, files: 1 }
  expect(rulesVerdict(write).action).toBe('deny')
  expect(rulesVerdict({ ...write, linesAdded: 100 }).action).toBe('ask')
  expect(rulesVerdict({ ...write, linesAdded: 101 }).action).toBe('deny')
  expect(rulesVerdict({ ...write, linesAdded: undefined }).action).toBe('ask')
})

test('a sensitive path asks whatever the size, even for a huge change', () => {
  for (const path of ['package.json', '.github/workflows/ci.yml', 'db/migrations/1.sql', 'bun.lock', 'deps.lock']) {
    expect(rulesVerdict({ ...ctx, path, linesAdded: 3000, linesRemoved: undefined, files: 5 }).action).toBe('ask')
  }
})

test('the verdict is only an action and a reason', () => {
  expect(Object.keys(rulesVerdict(ctx)).sort()).toEqual(['action', 'reason'])
})
