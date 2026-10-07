import type { On } from 'claude-code'

import type { Probe } from '../hooks/measure'

declare const setTimeout: (fn: () => void, ms: number) => unknown
export const pause = (ms: number) => new Promise<void>(done => setTimeout(() => done(), ms))
export const ran = (stdout: string, exitCode = 0) => ({
  exitCode,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

// The host under the tests: what each git command answers, by subcommand and by folder.
// /proj is on main, /work on andersonsilva/x and /detached has no branch; /empty has nothing staged.
export const answer = (argv: readonly string[], cwd = '/proj') => {
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

export const probe = (calls: string[] = []): Probe => ({
  run: async (argv, init) => {
    calls.push(argv.join(' '))

    return answer(argv, init.cwd)
  },
  home: async () => '/home/me',
  real: async path => path.replace(/^\/tmp(?=\/|$)/, '/private/tmp'),
})
export const world = (on: On) => {
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
export const BAND = {
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
