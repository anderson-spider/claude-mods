import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { classify, isProtectedTarget, measure } from '../hooks/guard'
import type { Probe } from '../hooks/guard'

declare const setTimeout: (fn: () => void, ms: number) => unknown
const pause = (ms: number) => new Promise<void>(done => setTimeout(() => done(), ms))
const kinds = (command: string) => classify(command).map(risk => risk.kind)
const ran = (stdout: string, exitCode = 0) => ({
  exitCode,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

// The host under the tests: what each git command answers, by subcommand and by folder.
// /proj is on main, /work on andersonsilva/x and /detached has no branch; /empty has nothing staged.
const answer = (argv: readonly string[], cwd = '/proj') => {
  const [, sub, second] = argv

  if (argv.includes('--show-toplevel')) {
    const root = cwd.replace(/^\/tmp/, '/private/tmp')

    return ran(`${root}\n${root}/.git\n`)
  }

  if (sub === 'branch') {
    return ran(cwd.startsWith('/work') ? 'andersonsilva/x\n' : cwd.startsWith('/detached') ? '\n' : 'main\n')
  }

  if (sub === 'diff') {
    if (cwd.startsWith('/empty')) {
      return ran('')
    }

    return ran(argv.includes('--shortstat') ? ' 2 files changed, 3 insertions(+)\n' : 'src/a.ts\nsrc/b.ts\n')
  }

  if (sub === 'status') {
    return ran(' M src/a.ts\n M src/b.ts\n?? notes.txt\n')
  }

  if (sub === 'log') {
    return ran('abc1234 fix the thing\ndef5678 add the other\n')
  }

  if (sub === 'rev-parse' && second === '--abbrev-ref') {
    return ran('origin/main\n')
  }

  return ran('')
}

const probe = (calls: string[] = []): Probe => ({
  run: async (argv, init) => {
    calls.push(argv.join(' '))

    return answer(argv, init.cwd)
  },
  home: async () => '/home/me',
  real: async path => path.replace(/^\/tmp(?=\/|$)/, '/private/tmp'),
})

const guarded = async (command: string, cwd = '/proj') => {
  const risks = classify(command)
  const each = await Promise.all(risks.map(risk => isProtectedTarget(probe(), risk, cwd)))

  return risks.length > 0 && each.some(Boolean)
}

const world = (on: On) => {
  const seen = { ran: [] as string[] }

  on('session.cwd', () => ({ value: '/proj' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.stat', (_$, e) => ({
    value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path.replace(/^\/tmp/, '/private/tmp') },
  }))
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'sleep') {
      await pause(5)
    }

    return { value: answer(e.argv, e.init?.cwd) }
  })
  // What the band shows when the mod has nothing to draw.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['idle'] }))
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen.ran.push(e.command)

    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' }
  })

  return seen
}

const BAND = {
  plugin: 'branch-guard',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 12,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

test('classify names commits and plain pushes, and leaves force pushes alone', () => {
  expect(kinds('ls -la && git status')).toEqual([])
  expect(kinds('git log --oneline')).toEqual([])
  expect(kinds('echo "git commit -m x"')).toEqual([])

  expect(kinds('git commit -m x')).toEqual(['commit'])
  expect(kinds('git commit -am "fix: the thing" && git push origin main')).toEqual(['commit', 'publish'])
  expect(kinds('git commit -n -m x')).toEqual(['commit'])
  expect(kinds('git commit --amend --no-edit')).toEqual(['commit'])
  expect(kinds('git commit -m "$(cat <<\'EOF\'\nfix: the thing\n\nbody\nEOF\n)"')).toEqual(['commit'])
  expect(kinds('git push')).toEqual(['publish'])
  expect(kinds('git push -u origin main')).toEqual(['publish'])
  expect(kinds('git push origin HEAD:main')).toEqual(['publish'])
  expect(kinds('git push origin :main')).toEqual(['publish'])
  expect(kinds('git push --all')).toEqual(['publish'])

  expect(kinds('git commit --dry-run')).toEqual([])
  expect(kinds('git push --dry-run origin main')).toEqual([])
  expect(kinds('git push -f')).toEqual([])
  expect(kinds('git push --force-with-lease origin main')).toEqual([])
  expect(kinds('git push origin +main')).toEqual([])
  expect(kinds('git push --tags')).toEqual([])
  expect(kinds('git push origin tag v1.2.0')).toEqual([])
  expect(kinds('git push origin refs/tags/v1.2.0')).toEqual([])
})

test('classify follows cd, git -C and the branch a checkout leaves active', () => {
  expect(classify('cd web && git commit -m x')[0]).toMatchObject({ kind: 'commit', dir: 'web' })
  expect(classify('git -C ../other commit -m x')[0]).toMatchObject({ kind: 'commit', dir: '../other' })
  expect(classify('git --git-dir /x/.git commit -m x')[0]).toMatchObject({ kind: 'commit', isElsewhere: true })
  expect(classify('cd "$X" && git commit -m x')[0]).toMatchObject({ isAdrift: true })
  expect(classify('git add -A && git commit -m x')[0]).toMatchObject({ stagesFirst: true })
  expect(classify('git commit -m x src/a.ts')[0]).toMatchObject({ hasPathspec: true })
  expect(classify('git commit -m "src/a.ts"')[0]).toMatchObject({ hasPathspec: false })

  expect(classify('git checkout -b andersonsilva/x && git commit -m x')[0]).toMatchObject({ branchAfter: 'andersonsilva/x' })
  expect(classify('git switch -c andersonsilva/x && git commit -m x')[0]).toMatchObject({ branchAfter: 'andersonsilva/x' })
  expect(classify('git checkout main && git commit -m x')[0]).toMatchObject({ branchAfter: 'main' })
  expect(classify('git switch - && git commit -m x')[0]).toMatchObject({ branchAfter: 'unknown' })
  expect(classify('git checkout -b x || true; git commit -m x')[0]).toMatchObject({ branchAfter: 'unknown' })
  expect(classify('git checkout -- src/a.ts && git commit -m x')[0]).not.toHaveProperty('branchAfter')
  expect(classify('git checkout src/a.ts && git commit -m x')[0]).not.toHaveProperty('branchAfter')
})

test('only a protected branch asks, and a repo inside /tmp never does', async () => {
  expect(await guarded('git commit -m x')).toBe(true)
  expect(await guarded('git commit -n -m x')).toBe(true)
  expect(await guarded('git add -A && git commit -m x', '/empty')).toBe(true)
  expect(await guarded('git checkout main && git commit -m x', '/work')).toBe(true)
  expect(await guarded('git push')).toBe(true)
  expect(await guarded('git push origin main')).toBe(true)
  expect(await guarded('git push origin HEAD:main', '/work')).toBe(true)
  expect(await guarded('git push origin :main', '/work')).toBe(true)
  expect(await guarded('git push --all', '/work')).toBe(true)
  expect(await guarded('git push origin "$BRANCH"', '/work')).toBe(true)
  expect(await guarded('git push origin release/2.0', '/work')).toBe(true)
  expect(await guarded('git push')).toBe(true)

  expect(await guarded('git commit -m x', '/work')).toBe(false)
  expect(await guarded('git commit -m x', '/detached')).toBe(false)
  expect(await guarded('git commit -m x', '/empty')).toBe(false)
  expect(await guarded('git commit --allow-empty -m x', '/empty')).toBe(true)
  expect(await guarded('git checkout -b andersonsilva/x && git commit -m x')).toBe(false)
  expect(await guarded('git switch - && git commit -m x')).toBe(false)
  expect(await guarded('cd "$X" && git commit -m x')).toBe(false)
  expect(await guarded('git --git-dir /x/.git commit -m x')).toBe(false)
  expect(await guarded('git push origin andersonsilva/x', '/work')).toBe(false)
  expect(await guarded('git push origin feature:andersonsilva/x', '/work')).toBe(false)
  expect(await guarded('cd /tmp/repo && git commit -m x')).toBe(false)
  expect(await guarded('git -C /tmp/repo push origin main')).toBe(false)
})

test('measure reports what the commit or the push would do, from git itself', async () => {
  const calls: string[] = []
  const report = (command: string, cwd = '/proj') => measure(probe(calls), classify(command), cwd)

  expect(await report('git commit -m x')).toEqual({
    title: 'git commit',
    notes: ['2 files changed, 3 insertions(+)'],
    summary: 'commit 2 files directly on main',
    lines: ['src/a.ts', 'src/b.ts'],
    total: 2,
  })
  expect(calls).toContain('git diff --cached --name-only')

  expect((await report('git commit -am x')).summary).toBe('commit 2 files directly on main')
  expect(calls.at(-1)).toBe('git status --porcelain')
  expect((await report('git add -A && git commit -m x')).lines).toEqual([' M src/a.ts', ' M src/b.ts', '?? notes.txt'])
  expect((await report('git commit --amend --no-edit')).summary).toBe('rewrite the last commit on main with 2 more files')

  calls.length = 0
  expect((await report('git push origin main')).summary).toBe('push 2 commits to origin/main')
  expect(calls.at(-1)).toBe('git log --oneline origin/main..main')
  expect((await report('git push')).summary).toBe('push 2 commits to origin/main')
  expect((await report('git push origin HEAD:main', '/work')).summary).toBe('push 2 commits to origin/main')
  expect(calls.at(-1)).toBe('git log --oneline origin/main..HEAD')
  expect(await report('git push origin :main', '/work')).toMatchObject({ summary: 'push nothing new to origin/main (compared without fetch)', lines: ['origin/main: will be deleted'] })
  expect((await report('git push --all')).summary).toBe('push all local branches to the remote (--all/--mirror)')
  expect((await report('git commit -m x && git push origin main')).title).toBe('git commit + git push')
})

test('commits and pushes on a feature branch or inside /tmp run untouched', async ($, on) => {
  const seen = world(on)

  for (const command of ['ls -la', 'cd /work && git commit -m x', 'cd /tmp/repo && git commit -m x', 'git push --force']) {
    const result = await $.tool.call({ tool: 'Bash', command })

    expect(result.deny).toBeUndefined()
  }

  expect(seen.ran).toHaveLength(4)
})

test('the band holds a commit on main: Cancel refuses it with advice, Proceed runs it', async ($, on) => {
  const seen = world(on)

  for (const surface of ['terminal', 'desktop'] as const) {
    seen.ran.length = 0

    const refused = $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
    await pause(50)
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '⚠ Branch Guard · git commit' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'commit 2 files directly on main' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'src/a.ts' })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
    await ui.press({ key: 'cancel' })

    const denied = (await refused).deny

    expect(denied).toMatch(/pressed Cancel\. It would commit 2 files directly on main\./)
    expect(denied).toMatch(/git switch -c <name>/)
    expect(seen.ran).toEqual([])
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)

    const allowed = $.tool.call({ tool: 'Bash', command: 'git push origin main' })
    await pause(50)
    expect(await ui.find({ type: 'Text', text: 'push 2 commits to origin/main' })).toBeDefined()
    await ui.press({ key: 'proceed' })

    expect((await allowed).deny).toBeUndefined()
    expect(seen.ran).toEqual(['git push origin main'])
    await ui.unmount()
  }
})

test('a push to a protected branch from another branch points to a pull request', async ($, on) => {
  world(on)

  const refused = $.tool.call({ tool: 'Bash', command: 'cd /work && git push origin HEAD:main' })
  await pause(50)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'cancel' })

  expect((await refused).deny).toMatch(/PR/)
  await ui.unmount()
})
