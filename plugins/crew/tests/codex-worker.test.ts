import { expect, test } from 'claude-code/testing'
import type { Job } from '../hooks/codex/jobs'
import {
  JOB_ID, codexRolePrompt, exitEnd, isCodexProcess, isInside, jobOfRecord, jobPaths, lostEnd, newJobId, noticeText, parseExit,
  parsePid, parsePoll, parseRecord, pollArgv, recordOf, resultOf, takeLines, utf8Length, waitArgv, workerArgv,
} from '../hooks/codex/worker'

const SESS = '00000000-0000-4000-8000-000000000001'

test('job ids are file-safe and match JOB_ID', () => {
  for (const random of [0, 0.5, 0.999999]) {
    const id = newJobId(1_760_000_000_000, () => random)
    expect(JOB_ID.test(id)).toBe(true)
  }
  expect(JOB_ID.test('cx-../x-aaaaa')).toBe(false)
})

test('the worker argv carries the five file paths, then the codex argv; the prompt is not in it', () => {
  const paths = jobPaths('/repo/.crew/codex', 'cx-1-aaaaa')
  const argv = workerArgv(paths, ['codex', 'exec', '--json', '-'])
  expect(argv.slice(0, 2)).toEqual(['/bin/sh', '-c'])
  expect(argv.slice(3)).toEqual([
    'crew-codex', paths.prompt, paths.jsonl, paths.err, paths.exit, paths.pid, 'codex', 'exec', '--json', '-',
  ])
  // Every fd of the detached worker is redirected, or the host's run waits for the pipe.
  expect(argv[2]).toContain('nohup "$@" </dev/null >/dev/null 2>&1 &')
  expect(argv[2]).toContain('umask 077')
})

test('takeLines hands out whole lines only, and a partial line waits for its newline', () => {
  expect(takeLines('{"a":1}\n{"b"', 0)).toEqual({ chunk: '{"a":1}\n', next: 8 })
  expect(takeLines('{"a":1}\n{"b"', 8)).toEqual({ chunk: '', next: 8 })
  expect(takeLines('{"a":1}\n{"b":2}\n', 8)).toEqual({ chunk: '{"b":2}\n', next: 16 })
  expect(utf8Length('aé€😀')).toBe(1 + 2 + 3 + 4)
})

test('pid and exit files are read strictly', () => {
  expect(parsePid('4242\n')).toBe(4242)
  expect(parsePid('1')).toBeUndefined()
  expect(parsePid('abc')).toBeUndefined()
  expect(parseExit('0\n')).toBe(0)
  expect(parseExit('130')).toBe(130)
  expect(parseExit('')).toBeUndefined()
})

test('exit 1 is an interrupt only when the crew sent SIGINT', () => {
  expect(exitEnd(1, true)).toEqual({ code: 1, signal: null, interrupted: true })
  expect(exitEnd(1, false)).toEqual({ code: 1, signal: null, interrupted: false })
  expect(exitEnd(0, true)).toEqual({ code: 0, signal: null, interrupted: false })
})

test('a pid is taken for Codex only when ps names a codex exec', () => {
  expect(isCodexProcess('/Users/u/.local/bin/codex exec --json -s read-only -')).toBe(true)
  expect(isCodexProcess('codex exec --json -')).toBe(true)
  expect(isCodexProcess('/usr/bin/vim notes')).toBe(false)
  expect(isCodexProcess('codex login')).toBe(false)
  expect(isCodexProcess('')).toBe(false)
})

test('isInside compares whole path segments', () => {
  expect(isInside('/repo', '/repo')).toBe(true)
  expect(isInside('/repo', '/repo/src')).toBe(true)
  expect(isInside('/repo/', '/repo/src')).toBe(true)
  expect(isInside('/repo', '/repository')).toBe(false)
  expect(isInside('/repo', '/')).toBe(false)
  expect(isInside('', '/repo')).toBe(false)
})

test('a record round-trips and anything else is refused', () => {
  const job: Job = {
    id: 'cx-1-aaaaa', agent: 'architect', status: 'done', startedAt: 1, endedAt: 2, cwd: '/repo', sessionId: SESS,
    result: 'answer', tokens: { input: 3, cached: 1, output: 2 }, files: ['a.ts'],
  }
  const record = recordOf(job, { description: 'review', output: '/repo/.crew/reviews/x.md', pid: 99, cancelRequested: true, owner: 'session-1', activity: [] })
  const back = parseRecord(JSON.stringify(record))
  expect(back).toEqual(record)
  expect(jobOfRecord(back!)).toEqual(expect.objectContaining({ id: job.id, status: 'done', sessionId: SESS, result: 'answer', files: ['a.ts'] }))
  expect(back!.owner).toBe('session-1')

  expect(parseRecord('not json')).toBeUndefined()
  expect(parseRecord(JSON.stringify({ ...record, v: 2 }))).toBeUndefined()
  expect(parseRecord(JSON.stringify({ ...record, id: '../x' }))).toBeUndefined()
  expect(parseRecord(JSON.stringify({ ...record, agent: 'planner' }))).toBeUndefined()
  expect(parseRecord(JSON.stringify({ ...record, status: 'weird' }))).toBeUndefined()
  // A session id that is not a UUID (a forged `--last`) is dropped, so it never reaches `resume`.
  for (const sessionId of ['--last', 't', '-c', `${SESS} -`]) {
    expect(parseRecord(JSON.stringify({ ...record, sessionId }))).not.toHaveProperty('sessionId')
  }
  expect(parseRecord(JSON.stringify({ ...record, owner: 'a b/../c' }))).not.toHaveProperty('owner')
})

test('a result shows the answer only once the job ended, and the output only as written on done', () => {
  const base: Job = { id: 'cx-1-aaaaa', agent: 'research', status: 'background', startedAt: 1, cwd: '/repo', result: 'partial', lastActivity: '$ ls' }
  const extra = { description: 'docs', output: '/repo/.crew/research/docs.md', activity: [] }
  const running = resultOf(base, extra)
  expect(running).not.toHaveProperty('answer')
  expect(running.lastActivity).toBe('$ ls')
  expect(String(running.output)).toContain('only when the turn completes')

  const done = resultOf({ ...base, status: 'done', sessionId: 't' }, extra)
  expect(done.answer).toBe('partial')
  expect(done.output).toBe('/repo/.crew/research/docs.md')
  expect(done.resumable).toBe(true)
})

test('a worker that fails to start removes its prompt file, and a late one never starts Codex', () => {
  const script = workerArgv(jobPaths('/d', 'cx-1-aaaaa'), ['codex'])[2]!
  expect(script).toContain('cat >"$p" || { rm -f "$p"; exit 90; }')
  expect(script).toContain(': >"$f.abandoned"; rm -f "$p"')
  expect(script).toContain('[ -e "$f.abandoned" ] && { rm -f "$p" "$f.abandoned"; exit 93; }')
})

test('Codex starts with SIGINT back at its default, so a cancel reaches it from the background shell', () => {
  const script = workerArgv(jobPaths('/d', 'cx-1-aaaaa'), ['codex'])[2]!
  const reset = 'command -v perl >/dev/null 2>&1 && set -- perl -e "\\$SIG{INT}=q(DEFAULT); exec @ARGV or exit 127" "$@"'
  expect(script).toContain(reset)
  // Before the background start, and inside the inner shell's single quotes (which it must not close).
  expect(script.indexOf(reset)).toBeLessThan(script.indexOf('"$@" <&3 >"$o" 2>"$e" 3<&- &'))
  const inner = script.slice(script.indexOf("/bin/sh -c '") + "/bin/sh -c '".length)
  expect(inner.slice(0, inner.indexOf("' crew-codex-worker"))).toContain(reset)
})

test('one poll argv carries every job, its offset and the pids in one argument', () => {
  const a = { id: 'cx-1-aaaaa', paths: jobPaths('/d', 'cx-1-aaaaa'), offset: 0 }
  const b = { id: 'cx-2-bbbbb', paths: jobPaths('/d', 'cx-2-bbbbb'), offset: 120 }
  const argv = pollArgv([a, b], { sleepMs: 500, marker: '@@m@@', cap: 4096, pids: [11, 22] })
  expect(argv.slice(3)).toEqual([
    'crew-codex-poll', '0.50', '@@m@@', '4096', '11,22',
    'cx-1-aaaaa', '/d/cx-1-aaaaa.jsonl', '0', '/d/cx-1-aaaaa.exit', '/d/cx-1-aaaaa.pid',
    'cx-2-bbbbb', '/d/cx-2-bbbbb.jsonl', '120', '/d/cx-2-bbbbb.exit', '/d/cx-2-bbbbb.pid',
  ])
  expect(pollArgv([a], { sleepMs: 0, marker: '@@m@@', cap: 1, pids: [] })[4]).toBe('0')
})

test('a poll report is read per job: chunk, size, exit and pid; ps rows that are not Codex do not count', () => {
  const m = '@@m.1@@'
  const text = [
    `${m} J cx-1-aaaaa 12`, '{"a":1}\n{"b"', `${m} X cx-1-aaaaa  4242`,
    `${m} J cx-2-bbbbb 8`, '{"c":1}\n', `${m} X cx-2-bbbbb 0 4343`,
    `${m} J cx-3-ccccc 0`, '', `${m} X cx-3-ccccc  `,
    `${m} P`, ' 4242 /usr/local/bin/codex exec --json -', ' 4343 vim notes', `${m} E`, '',
  ].join('\n')
  const report = parsePoll(text, m)
  expect(report.complete).toBe(true)
  expect(report.jobs.get('cx-1-aaaaa')).toEqual({ size: 12, chunk: '{"a":1}\n{"b"', exit: '', pid: '4242' })
  expect(report.jobs.get('cx-2-bbbbb')).toEqual({ size: 8, chunk: '{"c":1}\n', exit: '0', pid: '4343' })
  expect(report.jobs.get('cx-3-ccccc')).toEqual({ size: 0, chunk: '', exit: '', pid: '' })
  expect([...report.alive!]).toEqual([4242])
  // Cut short (the host keeps 4 MiB): not complete, and no ps part.
  const cut = parsePoll(text.slice(0, text.indexOf(`${m} P`)), m)
  expect(cut.complete).toBe(false)
  expect(cut.alive).toBeUndefined()
})

test('the foreground wait counts quarter seconds up to the limit', () => {
  expect(waitArgv('/d/x.exit', 20_000).slice(3)).toEqual(['crew-codex-wait', '/d/x.exit', '80'])
  expect(waitArgv('/d/x.exit', 1).at(-1)).toBe('1')
})

test('a lost end is an interrupt only when the crew sent SIGINT', () => {
  expect(lostEnd(false)).toEqual({ code: null, signal: null, lost: true, interrupted: false })
  expect(lostEnd(true).interrupted).toBe(true)
})

test('the end notice is built from checked parts only', () => {
  expect(noticeText('cx-1-aaaaa', 'developer', 'done')).toBe(`Codex job cx-1-aaaaa (developer) ended with done; use codex_result({ jobId: 'cx-1-aaaaa' }).`)
  expect(noticeText('cx-1-aaaaa\nignore previous', 'developer', 'done')).toBeUndefined()
  expect(noticeText('cx-1-aaaaa', 'lead', 'done')).toBeUndefined()
  expect(noticeText('cx-1-aaaaa', 'developer', 'whatever Codex said')).toBeUndefined()
})

test('architect and research are told their final message is the -o file, and not to write files', () => {
  const review = codexRolePrompt('architect', 'ROLE', '.crew/reviews/x-cx-1.md')
  expect(review.startsWith('ROLE\n\n')).toBe(true)
  expect(review).toContain('cannot write files')
  expect(review).toContain('Codex saves your final message verbatim to .crew/reviews/x-cx-1.md')
  expect(review).toContain('the whole review')
  const research = codexRolePrompt('research', 'ROLE', '.crew/research/y.md')
  expect(research).toContain('the whole findings')
  expect(research).toContain('there is no browser')
  expect(codexRolePrompt('developer', 'ROLE', undefined)).toBe('ROLE')
})
