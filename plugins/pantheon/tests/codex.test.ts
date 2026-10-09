import { describe, expect, test } from 'claude-code/testing'
import { buildArgv, createJsonlReader, parseEvent } from '../hooks/codex'
import { CODEX_EXEC_SAMPLE } from './fixtures/codex-exec-sample'
import type { CodexCall, CodexEvent } from '../hooks/types'

const base: CodexCall = {
  agent: 'executor', sandbox: 'workspace-write', noNetwork: false,
  prompt: 'task', cwd: '/repo', skipGitRepoCheck: false,
}

describe('codex argv', () => {
  test('git writes the common dir with TOML escaping and enables network', () => {
    expect(buildArgv({ ...base, agent: 'git', writableRoots: ['/repo "quoted"/back\\slash/.git'], network: true })).toEqual([
      'codex', 'exec', '--json', '-s', 'workspace-write',
      '-c', 'sandbox_workspace_write.writable_roots=["/repo \\"quoted\\"/back\\\\slash/.git"]',
      '-c', 'sandbox_workspace_write.network_access=true', '--ignore-rules', '-',
    ])
  })

  test('other roles retain their exact argv without the new fields', () => {
    for (const agent of ['explorer', 'librarian', 'executor', 'oracle', 'designer', 'councillor:alpha']) {
      for (const sandbox of ['read-only', 'workspace-write'] as const) {
        for (const noNetwork of [false, true]) {
          expect(buildArgv({ ...base, agent, sandbox, noNetwork })).toEqual([
            'codex', 'exec', '--json', '-s', sandbox,
            '-c', 'sandbox_workspace_write.writable_roots=[]',
            ...(noNetwork ? ['-c', 'sandbox_workspace_write.network_access=false'] : []),
            '--ignore-rules', '-',
          ])
        }
      }
    }
  })

  test('new run argv', () => {
    expect(buildArgv({ ...base, model: 'm', effort: 'high', noNetwork: true })).toEqual([
      'codex', 'exec', '--json', '-s', 'workspace-write', '-m', 'm',
      '-c', 'model_reasoning_effort=high',
      '-c', 'sandbox_workspace_write.writable_roots=[]',
      '-c', 'sandbox_workspace_write.network_access=false', '--ignore-rules', '-',
    ])
  })

  test('resume puts exec options before the subcommand', () => {
    expect(buildArgv({ ...base, sandbox: 'read-only', model: 'm', effort: 'low',
      noNetwork: true, skipGitRepoCheck: true, resumeSessionId: 'sess-1' })).toEqual([
      'codex', 'exec', '--json', '-s', 'read-only', '-m', 'm',
      '-c', 'model_reasoning_effort=low',
      '-c', 'sandbox_workspace_write.writable_roots=[]',
      '-c', 'sandbox_workspace_write.network_access=false', '--ignore-rules',
      '--skip-git-repo-check', 'resume', 'sess-1', '-',
    ])
  })

  test('optional flags are omitted when not asked', () => {
    expect(buildArgv(base)).toEqual([
      'codex', 'exec', '--json', '-s', 'workspace-write',
      '-c', 'sandbox_workspace_write.writable_roots=[]', '--ignore-rules', '-',
    ])
  })

  test('skip-git-repo-check only when asked', () => {
    expect(buildArgv(base)).not.toContain('--skip-git-repo-check')
    expect(buildArgv({ ...base, skipGitRepoCheck: true })).toEqual([
      'codex', 'exec', '--json', '-s', 'workspace-write',
      '-c', 'sandbox_workspace_write.writable_roots=[]', '--ignore-rules',
      '--skip-git-repo-check', '-',
    ])
  })

  test('writable_roots and ignore-rules always present', () => {
    for (const sandbox of ['read-only', 'workspace-write'] as const) {
      for (const noNetwork of [false, true]) {
        for (const resumeSessionId of [undefined, 'sess-1']) {
          const argv = buildArgv({ ...base, sandbox, noNetwork, resumeSessionId })
          expect(argv).toContain('sandbox_workspace_write.writable_roots=[]')
          expect(argv).toContain('--ignore-rules')
          expect(argv.slice(argv.indexOf('-s'), argv.indexOf('-s') + 2)).toEqual(['-s', sandbox])
          if (noNetwork) expect(argv).toContain('sandbox_workspace_write.network_access=false')
          else expect(argv).not.toContain('sandbox_workspace_write.network_access=false')
        }
      }
    }
  })

  test('unsafe sandbox is refused even from an untyped caller', () => {
    expect(() => buildArgv({ ...base, sandbox: 'danger-full-access' } as unknown as CodexCall)).toThrow()
  })

  test('prompt and cwd stay out of argv; model is a single argument', () => {
    const argv = buildArgv({ ...base, model: 'm with spaces', prompt: 'private task', cwd: '/private repo' })
    expect(argv).toContain('m with spaces')
    expect(argv).not.toContain('private task')
    expect(argv).not.toContain('/private repo')
    expect(argv.at(-1)).toBe('-')
  })
})

describe('codex events', () => {
  test('thread.started yields session', () => {
    expect(parseEvent({ type: 'thread.started', thread_id: 'sess-1' })).toEqual([
      { kind: 'session', sessionId: 'sess-1' },
    ])
  })

  test('command start yields activity without an exit code', () => {
    expect(parseEvent({ type: 'item.started', item: {
      type: 'command_execution', command: 'ls -1', exit_code: null,
    } })).toEqual([{ kind: 'activity', text: '$ ls -1' }])
  })

  test('command completion includes zero and nonzero exit codes', () => {
    expect(parseEvent({ type: 'item.completed', item: {
      type: 'command_execution', command: 'ls -1', exit_code: 0,
    } })).toEqual([{ kind: 'activity', text: '$ ls -1 → 0' }])
    expect(parseEvent({ type: 'item.completed', item: {
      type: 'command_execution', command: 'false', exit_code: 1,
    } })).toEqual([{ kind: 'activity', text: '$ false → 1' }])
  })

  test('command completion without an exit code remains activity', () => {
    expect(parseEvent({ type: 'item.completed', item: {
      type: 'command_execution', command: 'ls', exit_code: null,
    } })).toEqual([{ kind: 'activity', text: '$ ls' }])
  })

  test('agent_message yields message for start and completion', () => {
    for (const type of ['item.started', 'item.completed']) {
      expect(parseEvent({ type, item: { type: 'agent_message', text: 'answer' } })).toEqual([
        { kind: 'message', text: 'answer' },
      ])
    }
  })

  test('unknown item type becomes generic activity', () => {
    for (const type of ['item.started', 'item.completed']) {
      expect(parseEvent({ type, item: { type: 'file_change', changes: [] } })).toEqual([
        { kind: 'activity', text: 'file_change' },
      ])
    }
  })

  test('turn.completed maps token usage', () => {
    expect(parseEvent({ type: 'turn.completed', usage: {
      input_tokens: 12, cached_input_tokens: 4, output_tokens: 2,
      reasoning_output_tokens: 1,
    } })).toEqual([{ kind: 'usage', tokens: { input: 12, cached: 4, output: 2 } }])
  })

  test('missing cache count defaults to zero', () => {
    expect(parseEvent({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } })).toEqual([
      { kind: 'usage', tokens: { input: 0, cached: 0, output: 0 } },
    ])
  })

  test('turn.failed and error become failed', () => {
    expect(parseEvent({ type: 'turn.failed', error: { message: 'turn failed' } })).toEqual([
      { kind: 'failed', error: 'turn failed' },
    ])
    expect(parseEvent({ type: 'error', message: 'connection lost' })).toEqual([
      { kind: 'failed', error: 'connection lost' },
    ])
  })

  test('failure without a message still reports a useful error', () => {
    for (const type of ['turn.failed', 'error']) {
      expect(parseEvent({ type })).toEqual([
        { kind: 'failed', error: expect.stringContaining(type) },
      ])
    }
  })

  test('invalid objects and unrelated events are ignored', () => {
    for (const obj of [null, undefined, true, 3, 'text', [], {},
      { type: 'turn.started' }, { type: 'future.event' },
      { type: 'thread.started' }, { type: 'thread.started', thread_id: 1 },
      { type: 'item.completed' }, { type: 'item.started', item: null },
      { type: 'item.completed', item: { type: 'agent_message', text: 5 } },
      { type: 'item.completed', item: { type: 'command_execution', command: [] } },
      { type: 'item.completed', item: { type: 1 } },
      { type: 'turn.completed' },
      { type: 'turn.completed', usage: { input_tokens: '12', output_tokens: 2 } },
      { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: -1 } },
      { type: 'turn.completed', usage: { input_tokens: NaN, output_tokens: 2 } },
      { type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: '4', output_tokens: 2 } },
    ]) expect(parseEvent(obj)).toEqual([])
  })
})

describe('codex JSONL reader', () => {
  test('fixture yields session, activity, message and usage', () => {
    const r = createJsonlReader()
    const ev = r.push(CODEX_EXEC_SAMPLE)
    expect(ev).toHaveLength(6)
    expect(ev[0]).toEqual({ kind: 'session', sessionId: '01a11cfa-fdc8-7b61-a3ff-779df92a9d86' })
    expect(ev.filter(e => e.kind === 'activity')).toEqual([
      { kind: 'activity', text: "$ /bin/zsh -lc 'ls -1 | wc -l'" },
      { kind: 'activity', text: "$ /bin/zsh -lc 'ls -1 | wc -l' → 0" },
    ])
    expect(ev.filter(e => e.kind === 'message').at(-1)).toEqual({ kind: 'message', text: '3' })
    expect(ev.at(-1)).toEqual({ kind: 'usage', tokens: { input: 52107, cached: 25344, output: 68 } })
    expect(r.end()).toEqual([])
  })

  test('line split across chunks is read once', () => {
    const r = createJsonlReader()
    expect(r.push('{"type":"thread.started","thread_')).toEqual([])
    expect(r.push('id":"sess-1"}')).toEqual([])
    expect(r.push('\n')).toEqual([{ kind: 'session', sessionId: 'sess-1' }])
    expect(r.push('')).toEqual([])
    expect(r.end()).toEqual([])
  })

  test('one-character chunks preserve escaped text and multiple lines', () => {
    const r = createJsonlReader()
    const events: CodexEvent[] = []
    for (const char of '{"type":"item.completed","item":{"type":"agent_message","text":"ação\\n\\\"ok\\\""}}\n{"type":"thread.started","thread_id":"sess-2"}\n') {
      events.push(...r.push(char))
    }
    expect(events).toEqual([
      { kind: 'message', text: 'ação\n"ok"' }, { kind: 'session', sessionId: 'sess-2' },
    ])
    expect(r.end()).toEqual([])
  })

  test('end flushes the last line without a newline once', () => {
    const r = createJsonlReader()
    expect(r.push('{"type":"thread.started","thread_id":"sess-1"}')).toEqual([])
    expect(r.end()).toEqual([{ kind: 'session', sessionId: 'sess-1' }])
    expect(r.end()).toEqual([])
  })

  test('complete lines emit immediately while the tail remains buffered', () => {
    const r = createJsonlReader()
    expect(r.push('{"type":"thread.started","thread_id":"a"}\n{"type":"error","message":')).toEqual([
      { kind: 'session', sessionId: 'a' },
    ])
    expect(r.push('"oops"}\n')).toEqual([{ kind: 'failed', error: 'oops' }])
    expect(r.end()).toEqual([])
  })

  test('non-JSON lines and blank lines are ignored without losing valid events', () => {
    const r = createJsonlReader()
    expect(r.push('warning\n\n{broken}\n{"type":"thread.started","thread_id":"a"}\nnull\n')).toEqual([
      { kind: 'session', sessionId: 'a' },
    ])
    expect(r.push('{unfinished')).toEqual([])
    expect(r.end()).toEqual([])
  })

  test('CRLF split across chunks is accepted', () => {
    const r = createJsonlReader()
    expect(r.push('{"type":"thread.started","thread_id":"a"}\r')).toEqual([])
    expect(r.push('\n \r\n')).toEqual([{ kind: 'session', sessionId: 'a' }])
    expect(r.end()).toEqual([])
  })

  test('readers keep separate buffers', () => {
    const a = createJsonlReader()
    const b = createJsonlReader()
    expect(a.push('{"type":"thread.started","thread_id":')).toEqual([])
    expect(b.push('{"type":"thread.started","thread_id":"b"}\n')).toEqual([
      { kind: 'session', sessionId: 'b' },
    ])
    expect(a.push('"a"}\n')).toEqual([{ kind: 'session', sessionId: 'a' }])
    expect(b.end()).toEqual([])
  })
})
