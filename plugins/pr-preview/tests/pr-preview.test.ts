import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { check, classify, language, measure, textOf } from '../hooks/guard'
import type { Draft, Probe } from '../hooks/guard'

declare const setTimeout: (fn: () => void, ms: number) => unknown
const pause = (ms: number) => new Promise<void>(done => setTimeout(() => done(), ms))
const ran = (stdout: string, exitCode = 0) => ({
  exitCode,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const GOOD_PT = 'Esta mudança adiciona o plugin e não altera o resto do projeto, para evitar problemas.'
const GOOD_EN = 'This change adds the plugin and does not touch the rest of the project, to avoid problems.'

// The host under the tests: what git and cat answer. The repository is on andersonsilva/x.
const answer = (argv: readonly string[]) => {
  if (argv[0] === 'git' && argv[1] === 'branch') {
    return ran('andersonsilva/x\n')
  }

  if (argv[0] === 'cat') {
    return argv[1] === '/proj/body.md' ? ran(GOOD_EN) : ran('', 1)
  }

  return ran('')
}

const probe = (calls: string[] = []): Probe => ({
  run: async argv => {
    calls.push(argv.join(' '))

    return answer(argv)
  },
  home: async () => '/home/me',
})

const first = (command: string): Draft => {
  const [one] = classify(command)

  if (one === undefined) {
    throw new Error(`no draft in: ${command}`)
  }

  return one
}

const problems = (command: string, description?: string) => {
  const one = first(command)

  return check(one, description ?? textOf(one.description)).map(problem => problem.message)
}

const GITLAB = 'glab-work mr create --title "feat: add the plugin" --assignee @me --label feature'

const world = (on: On) => {
  const seen = { ran: [] as string[] }

  on('session.cwd', () => ({ value: '/proj' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'sleep') {
      await pause(5)
    }

    return { value: answer(e.argv) }
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
  plugin: 'pr-preview',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 24,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 24 },
    view: {},
  },
} as const

test('classify names gh pr create and glab mr create, and lets the rest through', () => {
  expect(classify('ls -la && gh pr list')).toEqual([])
  expect(classify('gh issue create --title x')).toEqual([])
  expect(classify('echo "gh pr create --title x"')).toEqual([])
  expect(classify('glab mr list')).toEqual([])

  expect(first('gh pr create --title x').platform).toBe('github')
  expect(first('glab mr create --title x').platform).toBe('gitlab')
  expect(first('glab-work mr create --title x').name).toBe('glab-work mr create')
  expect(first('glab-personal mr create --title x').platform).toBe('gitlab')
  expect(first('GH_TOKEN=x gh pr create --title x').name).toBe('gh pr create')
  expect(classify('gh pr create -t a && glab mr create -t b').map(one => one.platform)).toEqual(['github', 'gitlab'])
})

test('classify reads the options of each platform, including -d and -b that mean different things', () => {
  const gh = first('gh pr create -t "feat: x" -b "body" -a @me -l bug,docs -B main -H feature -d')

  expect(gh).toMatchObject({ isDraft: true, base: 'main', head: 'feature' })
  expect(gh.title?.text).toBe('feat: x')
  expect(gh.description?.text).toBe('body')
  expect(gh.assignees.map(word => word.text)).toEqual(['@me'])
  expect(gh.labels.map(word => word.text)).toEqual(['bug', 'docs'])

  const glab = first('glab mr create --title="feat: x" -d "body" -b main -s feature --label bug --label docs --assignee=@me --draft')

  expect(glab).toMatchObject({ isDraft: true, base: 'main', head: 'feature' })
  expect(glab.title?.text).toBe('feat: x')
  expect(glab.description?.text).toBe('body')
  expect(glab.labels.map(word => word.text)).toEqual(['bug', 'docs'])
  expect(glab.assignees.map(word => word.text)).toEqual(['@me'])

  expect(first('glab mr create -d "body"').isDraft).toBe(false)
  expect(first('gh pr create --fill').isFill).toBe(true)
  expect(first('gh pr create -tfeat:x').title?.text).toBe('feat:x')
})

test('classify holds gh pr edit and glab mr update, and reads their options', () => {
  expect(first('gh pr edit 12 --title "feat: x"')).toMatchObject({ platform: 'github', action: 'edit', name: 'gh pr edit' })
  expect(first('glab-work mr update 3 -t "feat: x"')).toMatchObject({ platform: 'gitlab', action: 'edit', name: 'glab-work mr update' })
  expect(first('gh pr create -t x').action).toBe('create')
  expect(first('glab mr new -t x').action).toBe('create')
  expect(classify('gh pr view 1 && glab mr view 3 && glab mr merge 3')).toEqual([])
  expect(first('gh pr edit 12 -b "body" --add-label bug').description?.text).toBe('body')
  expect(first('glab mr update 3 -d "body" -l bug').description?.text).toBe('body')
})

test('classify follows cd', () => {
  expect(first('cd sub && gh pr create -t x').dir).toBe('sub')
  expect(first('cd "$X" && gh pr create -t x').isAdrift).toBe(true)
})

test('textOf reads a heredoc description and leaves anything else the shell expands unknown', () => {
  const heredoc = first('gh pr create -t "feat: x" -b "$(cat <<\'EOF\'\n## Summary\n\nDoes the thing.\nEOF\n)"')

  expect(textOf(heredoc.description)).toBe('## Summary\n\nDoes the thing.')
  expect(textOf(first('gh pr create -b "$BODY"').description)).toBeUndefined()
  expect(textOf(first('gh pr create -b plain').description)).toBe('plain')
  expect(textOf(undefined)).toBeUndefined()
})

test('language tells Brazilian Portuguese from English, and stays silent when the text says too little', () => {
  expect(language(GOOD_PT)).toBe('pt')
  expect(language(GOOD_EN)).toBe('en')
  expect(language('Adiciona um plugin novo')).toBe('pt')
  expect(language('feat: add pr-preview plugin')).toBe('en')
  expect(language('pr-preview plugin')).toBeUndefined()
  expect(language('ok')).toBeUndefined()
  expect(language('Run `não para que` and see https://example.com/não-para')).toBe('en')
})

test('a merge request that follows the conventions has no problems', () => {
  expect(problems(`${GITLAB} --description "${GOOD_PT}"`)).toEqual([])
  expect(problems('gh pr create --title "fix(api): handle errors" --body "' + GOOD_EN + '"')).toEqual([])
})

test('check flags the title, the description, the assignee, the label and any mention of AI', () => {
  expect(problems(`${GITLAB} --title "Add the plugin" --description "${GOOD_PT}"`)).toEqual([
    'The title is not Conventional Commits: "Add the plugin".',
  ])
  expect(problems(`glab mr create --title "feat: adiciona o plugin para a equipe" --assignee @me --label x --description "${GOOD_PT}"`)).toEqual([
    'The title is not in English.',
  ])
  expect(problems(`${GITLAB} --description "${GOOD_EN}"`)).toEqual([
    'The description looks like English, and GitLab asks for Brazilian Portuguese.',
  ])
  expect(problems(`gh pr create --title "feat: x" --body "${GOOD_PT}"`)).toEqual([
    'The description looks like Brazilian Portuguese, and GitHub asks for English.',
  ])
  expect(problems(`glab mr create --title "feat: x" --label x --description "${GOOD_PT}"`)).toEqual(['You are not the assignee.'])
  expect(problems(`glab mr create --title "feat: x" --assignee @me --description "${GOOD_PT}"`)).toEqual(['There is no label.'])
  expect(problems('gh pr create --title "feat: x"')).toEqual(['There is no description.'])
  expect(problems('gh pr create --body "' + GOOD_EN + '"')).toEqual(['There is no title.'])
  expect(problems(`${GITLAB} --description "${GOOD_PT}\n\nCo-Authored-By: Claude"`)).toEqual(['The text mentions AI.'])
  expect(problems(`${GITLAB} --title "feat: add AI support" --description "${GOOD_PT}"`)).toEqual(['The text mentions AI.'])
})

test('check on an edit flags only what it is given: title, description and any mention of AI', () => {
  expect(problems('gh pr edit 12 --add-label bug')).toEqual([])
  expect(problems('glab mr update 3 --draft')).toEqual([])
  expect(problems('gh pr edit 12 --title "Add it"')).toEqual(['The title is not Conventional Commits: "Add it".'])
  expect(problems('gh pr edit 12 --title "feat: adiciona o plugin novo"')).toEqual(['The title is not in English.'])
  expect(problems(`gh pr edit 12 --body "${GOOD_PT}"`)).toEqual([
    'The description looks like Brazilian Portuguese, and GitHub asks for English.',
  ])
  expect(problems(`glab mr update 3 --description "${GOOD_EN}"`)).toEqual([
    'The description looks like English, and GitLab asks for Brazilian Portuguese.',
  ])
  expect(problems('gh pr edit 12 --title "feat: x" --body "Generated with Claude Code"')).toEqual(['The text mentions AI.'])
})

test('measure previews an edit with only what it changes', async () => {
  const calls: string[] = []
  const { report } = await measure(probe(calls), classify('gh pr edit 12 --title "feat: x" --body-file body.md --base main'), '/proj')

  expect(report.title).toBe('gh pr edit')
  expect(report.summary).toBe('edit a pull request on GitHub')
  expect(report.lines[0]).toBe('Title     feat: x')
  expect(report.lines).toContain('Base      main')
  expect(report.lines).toContain(GOOD_EN)
  expect(calls.some(call => call.startsWith('git'))).toBe(false)

  const gitlab = await measure(probe(), classify('glab mr update 3 --label bug'), '/proj')

  expect(gitlab.report.summary).toBe('update a merge request on GitLab')
  expect(gitlab.report.lines).toEqual(['Labels    bug'])

  const bare = await measure(probe(), classify('gh pr edit 12 --add-reviewer someone'), '/proj')

  expect(bare.report.lines).toEqual(['No title or description change'])
  expect(gitlab.report.problems).toEqual([])
})

test('check trusts what only the shell knows, and --fill takes the text from the commits', () => {
  expect(problems('glab mr create --title "feat: x" --assignee "$ME" --label "$L" --description "$D"')).toEqual([])
  expect(problems('gh pr create --fill')).toEqual([])
  expect(problems(`glab mr create --fill --assignee @me --label x`)).toEqual([])
})

test('measure previews the title, the branches, the assignee, the labels and the description', async () => {
  const calls: string[] = []
  const { report, advice } = await measure(
    probe(calls),
    classify(`${GITLAB} -b main --description "line one\nline two"`),
    '/proj',
  )

  expect(report.title).toBe('glab-work mr create')
  expect(report.summary).toBe('open a merge request on GitLab')
  expect(report.lines.slice(0, 4)).toEqual([
    'Title     feat: add the plugin',
    'Branches  andersonsilva/x → main',
    'Assignee  @me',
    'Labels    feature',
  ])
  expect(report.lines.slice(-2)).toEqual(['line one', 'line two'])
  expect(report.total).toBe(report.lines.length)
  expect(calls).toEqual(['git branch --show-current'])
  expect(advice).toBe('')
})

test('measure reads --body-file with cat, notes a draft and flags what is wrong', async () => {
  const calls: string[] = []
  const { report, advice } = await measure(
    probe(calls),
    classify('gh pr create --title "Add it" --body-file body.md --draft'),
    '/proj',
  )

  expect(report.summary).toBe('open a pull request on GitHub as a draft')
  expect(report.lines).toContain(GOOD_EN)
  expect(calls).toContain('cat /proj/body.md')
  expect(report.problems).toEqual(['The title is not Conventional Commits: "Add it".'])
  expect(advice).toMatch(/Use `type\(scope\): subject`/)
})

test('measure tells what it could not read and how many creations it left out', async () => {
  const { report } = await measure(
    probe(),
    classify('cd "$X" && gh pr create --title "$T" --body "$B" && gh pr create --fill'),
    '/proj',
  )

  expect(report.lines[0]).toMatch(/not readable/)
  expect(report.lines.at(-1)).toMatch(/Description not readable/)
  expect(report.notes).toEqual(['1 other command on this line is not previewed.'])
})

test('a command that is not a pull request or merge request creation runs untouched', async ($, on) => {
  const seen = world(on)

  for (const command of ['ls -la', 'gh pr list', 'glab mr view 3', 'git push origin feature']) {
    const result = await $.tool.call({ tool: 'Bash', command })

    expect(result.deny).toBeUndefined()
  }

  expect(seen.ran).toHaveLength(4)
})

test('the band holds a creation: Cancel refuses it, Fix hands the problems back, Proceed runs it', async ($, on) => {
  const seen = world(on)

  for (const surface of ['terminal', 'desktop'] as const) {
    seen.ran.length = 0

    const bad = 'glab mr create --title "Add it" --description "' + GOOD_EN + '"'
    const refused = $.tool.call({ tool: 'Bash', command: bad })
    await pause(50)
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '⚠ PR Preview · glab mr create' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'open a merge request on GitLab' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✗ You are not the assignee.' })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(3)
    await ui.press({ key: 'cancel' })

    expect((await refused).deny).toMatch(/pressed Cancel\. It would open a merge request on GitLab\./)
    expect(seen.ran).toEqual([])
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)

    const fixed = $.tool.call({ tool: 'Bash', command: bad })
    await pause(50)
    await ui.press({ key: 'fix' })

    const denied = (await fixed).deny

    expect(denied).toMatch(/asked for a fix/)
    expect(denied).toMatch(/Add `--assignee @me`/)
    expect(denied).toMatch(/Add `--label <label>`/)
    expect(seen.ran).toEqual([])

    const good = `${GITLAB} --description "${GOOD_PT}"`
    const allowed = $.tool.call({ tool: 'Bash', command: good })
    await pause(50)
    expect(await ui.find({ type: 'Text', text: 'Title     feat: add the plugin' })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
    await ui.press({ key: 'proceed' })

    expect((await allowed).deny).toBeUndefined()
    expect(seen.ran).toEqual([good])
    await ui.unmount()
  }
})
