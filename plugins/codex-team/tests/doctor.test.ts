import { expect, test } from 'claude-code/testing'
import { checkDoctor } from '../hooks/doctor'

type Answer = { exitCode: number; stdout?: string; stderr?: string } | undefined

/** A `run` that answers by the first words of the argv, and an unknown command as missing. */
function runOf(answers: Record<string, Answer>) {
  const argvs: string[][] = []
  const run = async (argv: string[]) => {
    argvs.push(argv)
    const answer = answers[argv.slice(0, 3).join(' ')] ?? answers[argv.slice(0, 2).join(' ')]

    return answer && { exitCode: answer.exitCode, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
  }

  return { run, argvs }
}

test('doctor passes when inside Herdr and both tools and the agent list answer', async () => {
  const { run } = runOf({
    'herdr --version': { exitCode: 0, stdout: 'herdr 0.9.3\nextra' },
    'codex --version': { exitCode: 0, stdout: 'codex 1.2.0' },
    'herdr agent list': { exitCode: 0 },
  })

  const text = await checkDoctor(run, true)

  expect(text).toContain('✓ inside Herdr: HERDR_ENV=1')
  expect(text).toContain('✓ herdr: herdr 0.9.3')
  expect(text).not.toContain('extra')
  expect(text).toContain('✓ codex: codex 1.2.0')
  expect(text).toContain('✓ herdr agent list: answers')
  expect(text).toContain('Everything codex-team relies on is in place.')
})

test('doctor names each failure: outside Herdr, missing tools, an agent list that fails', async () => {
  const { run } = runOf({
    'herdr --version': { exitCode: 1 },
    'herdr agent list': { exitCode: 2, stderr: `  ${'x'.repeat(300)}  ` },
  })

  const text = await checkDoctor(run, false)

  expect(text).toContain('✗ inside Herdr: HERDR_ENV is not 1: run Claude Code in a Herdr pane')
  expect(text).toContain('✗ herdr: not installed or not in PATH')
  expect(text).toContain('✗ codex: not installed or not in PATH')
  expect(text).toContain(`✗ herdr agent list: ${'x'.repeat(200)}`)
  expect(text).not.toContain('x'.repeat(201))
  expect(text).toContain('4 check(s) failed.')
})

test('doctor reports a command that did not answer at all', async () => {
  const { run } = runOf({})

  const text = await checkDoctor(run, true)

  expect(text).toContain('✗ herdr agent list: no answer')
  expect(text).toContain('3 check(s) failed.')
})
