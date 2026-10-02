import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { classify, isDisposable, measure, resolve, size } from '../hooks/risk'
import type { Probe } from '../hooks/risk'

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
const BUILD = Array.from({ length: 9 }, (_, at) => `/proj/build/file-${at}.o`).join('\n')

// O host por baixo dos testes: o que cada dry run responde, por executável e subcomando.
const answer = (argv: readonly string[], cwd = '/proj') => {
  const [tool, sub] = argv

  // Onde o repositório fica: /tmp/worktree é um worktree ligado a um repositório de fora.
  if (argv.includes('--show-toplevel')) {
    const root = cwd.replace(/^\/tmp/, '/private/tmp')
    const common = cwd.startsWith('/tmp/worktree') ? '/home/me/project/.git' : `${root}/.git`

    return cwd.startsWith('/tmp/plain') ? ran('', 128) : ran(`${root}\n${common}\n`)
  }

  if (tool === 'find') {
    return ran(BUILD)
  }

  if (tool === 'du') {
    return ran('1126\t/proj/build\n1126\ttotal\n')
  }

  if (tool === 'git' && sub === 'status') {
    return ran(' M src/a.ts\n M src/b.ts\n?? notes.txt\n')
  }

  if (tool === 'git' && sub === 'diff') {
    return ran(' 2 files changed, 2 insertions(+), 1 deletion(-)\n')
  }

  if (tool === 'git' && sub === 'log') {
    return ran('abc1234 fix the thing\ndef5678 add the other\n')
  }

  if (tool === 'git' && sub === 'clean') {
    return ran('Would remove dist/\nWould remove tmp.log\n')
  }

  if (tool === 'git' && sub === 'rev-parse') {
    return ran(argv.includes('@{u}') ? 'origin/main\n' : 'main\n')
  }

  return ran('[X]  auth.0001_initial\n[ ]  shop.0002_prices\n[ ]  shop.0003_stock\n')
}

const probe = (calls: string[] = []): Probe => ({
  run: async (argv, init) => {
    calls.push(argv.join(' '))

    return answer(argv, init.cwd)
  },
  list: async () => [
    { name: 'a.log', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
    { name: '.hidden.log', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
    { name: 'keep.txt', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
  ],
  home: async () => '/home/me',
  real: async path => {
    if (path.startsWith('/tmp/link')) {
      return path.replace('/tmp/link', '/home/me/project')
    }

    return path.endsWith('/missing')
      ? undefined
      : path.replace(/^\/tmp(?=\/|$)/, '/private/tmp').replace(/^\/var\/folders/, '/private/var/folders')
  },
})

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
  // O que a faixa mostra quando o mod não tem nada a desenhar.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['idle'] }))
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen.ran.push(e.command)

    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' }
  })

  return seen
}

const BAND = {
  plugin: 'blast-radius',
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

test('classify names the risky commands and lets the rest through', () => {
  expect(kinds('ls -la && git status')).toEqual([])
  expect(kinds('rm notes.txt')).toEqual([])
  expect(kinds('git clean -n -fd')).toEqual([])
  expect(kinds('git push origin main')).toEqual([])
  expect(kinds('git push --force --dry-run')).toEqual([])
  expect(kinds('python manage.py showmigrations')).toEqual([])
  expect(kinds('echo "rm -rf build"')).toEqual([])

  expect(kinds('rm -rf build')).toEqual(['rm'])
  expect(kinds('sudo /bin/rm -Rf -- -weird')).toEqual(['rm'])
  expect(kinds('git reset --hard HEAD~2')).toEqual(['reset'])
  expect(kinds('git clean -fdx')).toEqual(['clean'])
  expect(kinds('git push -f')).toEqual(['push'])
  expect(kinds('git push --force-with-lease origin andersonsilva/x')).toEqual(['push'])
  expect(kinds('git push origin +main')).toEqual(['push'])
  expect(kinds('python manage.py migrate')).toEqual(['migrate'])
  expect(kinds('RAILS_ENV=production bundle exec rails db:migrate')).toEqual(['migrate'])
  expect(kinds('npx prisma migrate deploy 2>&1 | tail -5')).toEqual(['migrate'])
  expect(kinds('make build; rm -rf dist && git clean -fd')).toEqual(['rm', 'clean'])
})

test('classify follows cd and git -C, and keeps what only the shell can expand apart', () => {
  expect(classify('cd web && rm -rf dist "my dir"')).toEqual([
    {
      kind: 'rm',
      dir: 'web',
      targets: [
        { text: 'dist', isUnknown: false, isGlob: false, isHome: false },
        { text: 'my dir', isUnknown: false, isGlob: false, isHome: false },
      ],
    },
  ])
  expect(classify('rm -rf "$DIR"/* ~/cache \'*.log\'')[0]).toMatchObject({
    targets: [
      { text: '$DIR/*', isUnknown: true, isGlob: true },
      { text: '~/cache', isHome: true },
      { text: '*.log', isGlob: false },
    ],
  })
  expect(classify('git -C ../other -c user.name=x reset --hard origin/main')).toEqual([
    { kind: 'reset', dir: '../other', ref: 'origin/main', isElsewhere: false },
  ])
  expect(classify('git clean -fdx -e node_modules')).toEqual([
    { kind: 'clean', dir: '.', args: ['clean', '-n', '-dx', '-e', 'node_modules'], isElsewhere: false },
  ])
  expect(classify('RAILS_ENV=production bin/rails db:migrate')[0]).toMatchObject({
    env: { RAILS_ENV: 'production' },
    status: ['bin/rails', 'db:migrate:status'],
  })
  expect(classify('S=/tmp/demo; cd $S && rm -rf "$S/build" ${S}x $T')).toEqual([
    {
      kind: 'rm',
      dir: '/tmp/demo',
      targets: [
        { text: '/tmp/demo/build', isUnknown: false, isGlob: false, isHome: false },
        { text: '/tmp/demox', isUnknown: false, isGlob: false, isHome: false },
        { text: '$T', isUnknown: true, isGlob: false, isHome: false },
      ],
    },
  ])
  expect(classify('cd "$X" && rm -rf build')[0]).toMatchObject({ dir: '.', isAdrift: true })
  expect(resolve('/proj', '../other/./x')).toBe('/other/x')
  expect(size(1126)).toBe('1.1 MB')
})

test('measure reports what each risk would change, from the tools own dry runs', async () => {
  const calls: string[] = []
  const report = (command: string) => measure(probe(calls), classify(command), '/proj')

  expect(await report('rm -rf build')).toEqual({
    title: 'rm -rf',
    notes: ['Caminhos: build'],
    summary: 'apagar 9 arquivos (1.1 MB)',
    lines: Array.from({ length: 9 }, (_, at) => `build/file-${at}.o`),
    total: 9,
  })
  expect(calls).toEqual(['find /proj/build ! -type d', 'du -skc /proj/build'])

  calls.length = 0
  await report('cd logs && rm -rf *.log')
  expect(calls[0]).toBe('find /proj/logs/a.log ! -type d')

  expect((await report('rm -rf / "$DIR"')).summary).toBe('apagar recursivamente alvos que não consegui medir')
  expect((await report('git reset --hard HEAD~2')).summary).toBe(
    'descartar alterações não commitadas em 2 arquivos e tirar 2 commits do branch',
  )
  expect(await report('git clean -fd')).toEqual({
    title: 'git clean',
    notes: [],
    summary: 'apagar 2 itens não rastreados',
    lines: ['dist/', 'tmp.log'],
    total: 2,
  })

  calls.length = 0
  expect((await report('git push --force')).summary).toBe('sobrescrever 2 commits de origin/main')
  expect(calls.at(-1)).toBe('git log --oneline HEAD..origin/main')
  expect(await report('python manage.py migrate')).toEqual({
    title: 'migração Django',
    notes: [],
    summary: 'aplicar 2 migrações no banco (Django)',
    lines: ['shop.0002_prices', 'shop.0003_stock'],
    total: 2,
  })
  expect(calls.at(-1)).toBe('python manage.py showmigrations --plan')
})

test('rm -rf, git reset --hard and git clean pass unasked only inside a system temp directory', async () => {
  const passes = async (command: string) => {
    const risks = classify(command)
    const each = await Promise.all(risks.map(risk => isDisposable(probe(), risk, '/proj')))

    return risks.length > 0 && each.every(Boolean)
  }

  for (const command of [
    'rm -rf /tmp/demo/build',
    'rm -rf /private/tmp/claude-501/-Users-me/session/scratchpad/blast-demo',
    'cd /tmp/demo && rm -rf build dist',
    'rm -rf /var/folders/ab/hash/T/cache',
    'rm -rf /tmp/demo/missing',
    'rm -rf /tmp/logs/*.log',
    'git -C /tmp/repo reset --hard',
    'cd /tmp/repo && git clean -fd',
    'cd /tmp/repo/src && git reset --hard HEAD~1 && rm -rf /tmp/repo/dist',
    'S=/tmp/demo; mkdir -p $S/sub && cd $S && ls; cd / && rm -rf $S',
    'D=/tmp/demo && rm -rf "${D}/build" $D/dist',
    'cd $HOME && cd /tmp/demo && rm -rf build',
  ]) {
    expect(`${command}: ${await passes(command)}`).toBe(`${command}: true`)
  }

  for (const command of [
    'rm -rf /tmp',
    'rm -rf /tmp/',
    'rm -rf /tmp/*',
    'rm -rf /var/folders/ab/hash/T',
    'rm -rf /tmp/claude-501',
    'rm -rf /tmp/demo ~/project',
    'rm -rf "$TMPDIR"/x',
    'rm -rf tmp',
    'rm -rf /proj/tmp/cache',
    'rm -rf /tmp/link/sub',
    'git reset --hard',
    'git clean -fd',
    'git -C /tmp/worktree reset --hard',
    'git -C /tmp/plain clean -fd',
    'git --git-dir=/proj/.git -C /tmp/repo reset --hard',
    'git -C /tmp/repo push --force',
    'cd /tmp/repo && git clean -fd && rm -rf ~/project',
    'S=$(mktemp -d); rm -rf $S',
    'rm -rf $S; S=/tmp/demo',
    'false || S=/tmp/demo; rm -rf $S',
    '(S=/tmp/demo); rm -rf $S',
    'if false; then S=/tmp/demo; fi; rm -rf $S',
    'S=/tmp/demo; export S=$HOME; rm -rf $S',
    'S=/tmp/demo ls; rm -rf $S',
    'S=~/project; rm -rf $S',
    'cd /tmp/demo && cd $OTHER && rm -rf build',
    'cd /tmp/demo && cd - && rm -rf build',
  ]) {
    expect(`${command}: ${await passes(command)}`).toBe(`${command}: false`)
  }
})

test('a safe command, and an rm -rf or a git reset inside /tmp, run untouched', async ($, on) => {
  const seen = world(on)

  const result = await $.tool.call({ tool: 'Bash', command: 'ls -la' })

  expect(result.deny).toBeUndefined()
  expect(seen.ran).toEqual(['ls -la'])

  const disposable = await $.tool.call({ tool: 'Bash', command: 'rm -rf /tmp/demo/build' })

  expect(disposable.deny).toBeUndefined()
  expect(seen.ran).toEqual(['ls -la', 'rm -rf /tmp/demo/build'])

  const reset = await $.tool.call({ tool: 'Bash', command: 'cd /tmp/repo && git reset --hard' })

  expect(reset.deny).toBeUndefined()
  expect(seen.ran).toHaveLength(3)
})

test('the band holds a risky command: Cancel refuses it, Proceed runs it', async ($, on) => {
  const seen = world(on)

  for (const surface of ['terminal', 'desktop'] as const) {
    seen.ran.length = 0

    const refused = $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
    await pause(50)
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '⚠ Blast Radius · rm -rf' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'apagar 9 arquivos (1.1 MB)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Caminhos: build' })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
    await ui.press({ key: 'cancel' })

    expect((await refused).deny).toMatch(/pressionou Cancelar\. Ele iria apagar 9 arquivos \(1\.1 MB\)\./)
    expect(seen.ran).toEqual([])
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)

    const allowed = $.tool.call({ tool: 'Bash', command: 'git reset --hard' })
    await pause(50)
    expect(await ui.find({ type: 'Text', text: 'descartar alterações não commitadas em 2 arquivos' })).toBeDefined()
    expect(
      await ui.find({ text: '2 files changed, 2 insertions(+), 1 deletion(-). Alterações não commitadas' }),
    ).toBeDefined()
    await ui.press({ key: 'proceed' })

    expect((await allowed).deny).toBeUndefined()
    expect(seen.ran).toEqual(['git reset --hard'])
    await ui.unmount()
  }
})
