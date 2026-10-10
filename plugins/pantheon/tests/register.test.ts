import { describe, expect, test, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpawnInput, ConfigSetInput, FsStat, On, TurnStepInput } from 'claude-code'

import type { Job, Native, SessionInfo } from '../types'
import { createQueue, resolveGatePath, withGateRecovery } from '../hooks/register'
import { gateContext } from '../hooks/gate'
import { PANE_ID } from '../hooks/pane'
import { DELEGATE, HOME, RESULT, ROOT, parse, start, world } from './fixtures/world'

const spawnInput = {
  tool_use_id: 'spawn-1', prompt: 'Review the change', description: 'Review',
  subagentType: 'pantheon:oracle', provider: { plugin: 'pantheon', tier: 'user' },
  parentModel: 'parent', permissionMode: 'default',
} as AgentSpawnInput
const stepInput = (index = 0, agentId: string | undefined = 'native-1'): TurnStepInput => ({
  turnId: 'turn-1', index, agentId, model: 'model-1', effort: 'high', messageCount: 1,
})
const completeInput = { turnId: 'turn-1', reason: 'answer' as const, answer: 'Answer', durationMs: 42, isAborted: false }
const measureInput = { context: { tokens: 100, window: 1000, percent: 10 }, rateLimits: [], changed: ['context'] as ['context'] }
const stepResult = {
  turnId: 'turn-1', index: 0, answer: 'Step answer', toolUses: [], stopReason: 'end_turn' as const,
  usage: { model: 'model-1', input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 },
}
const streamChunk = { kind: 'text' as const, index: 0, text: 'streaming' }

const gateEdit = { tool: 'Edit', tool_use_id: 'gate-edit', file_path: '/repo/src/a.ts', old_string: 'private old text', new_string: 'private new text' }
const gatePause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function gateWorld(on: On, opts: { score?: number; key?: string; reject?: boolean; interrupt?: boolean; fault?: 'workspace' | 'env'; files?: Record<string, string>; cwd?: string; realPaths?: Record<string, string | undefined>; statErrors?: Record<string, string>; unresolvedLinks?: string[]; uid?: string | null } = {}) {
  const fixture = world(new Proxy(on, {
    apply(target, self, args) {
      if (args[0] === 'session.cwd' && (opts.fault === 'workspace' || opts.cwd)) return
      if (args[0] === 'fs.stat' && (opts.realPaths || opts.statErrors || opts.unresolvedLinks)) return
      if (args[0] !== 'env.get' && args[0] !== 'process.run') return Reflect.apply(target, self, args)
    },
  }), { files: opts.files })
  const sent: { body?: string; headers?: Record<string, string> }[] = []
  const forwarded: unknown[] = []
  let probes = 0
  let uidReads = 0
  let polls = 0
  const inspected: { path: string; resolve: boolean }[] = []
  if (opts.fault === 'workspace') on('session.cwd', () => { throw new Error('private workspace error') })
  else if (opts.cwd) on('session.cwd', () => ({ value: opts.cwd! }))
  if (opts.realPaths || opts.statErrors || opts.unresolvedLinks) on('fs.stat', (_$, e) => {
    inspected.push({ path: e.path, resolve: e.resolve === true })
    if (opts.unresolvedLinks?.includes(e.path)) {
      return { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: true } }
    }
    if (opts.statErrors?.[e.path]) return { deny: opts.statErrors[e.path] }
    const realPath = opts.realPaths && Object.hasOwn(opts.realPaths, e.path) ? opts.realPaths[e.path] : e.path
    if (!realPath) return { deny: 'ENOENT: missing path' }
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: realPath !== e.path, realPath } }
  })
  on('env.get', (_$, e) => {
    if (opts.fault === 'env') throw new Error('private environment error')
    return { value: e.name === 'HOME' ? HOME : e.name === 'OPENROUTER_API_KEY' ? opts.key : undefined }
  })
  on('process.run', async (_$, e) => {
    if (e.argv.join(' ') === 'id -u') {
      uidReads++
      return { value: { exitCode: opts.uid === null ? 1 : 0, stdout: opts.uid ?? (opts.uid === null ? '' : '501\n'), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'sleep') {
      polls++
      if (opts.interrupt) throw new Error('interrupted host wait')
      await gatePause(5)
    } else probes++
    return { value: { exitCode: 0, stdout: ROOT, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', (_$, e) => {
    sent.push({ body: e.init?.body, headers: e.init?.headers })
    if (opts.reject) throw new Error('network unavailable')
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers: { trivial: { noul: opts.score ?? 0.95 } } }) } }
  })
  on('tool.call', (_$, e) => { forwarded.push(e); return { result: 'unchanged' } })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['idle'] }))
  return { ...fixture, sent, forwarded, inspected, probes: () => probes, uidReads: () => uidReads, polls: () => polls }
}

describe('edit gate', () => {
  for (const session of [{ isInteractive: false, surface: null }, { isInteractive: true, surface: null }, { isInteractive: false, surface: 'terminal' as const }]) {
    test(`ask denies without polling when no interactive surface can answer: ${JSON.stringify(session)}`, { options: { gate: true } }, async ($, on) => {
      const opts = { interrupt: false }
      const host = gateWorld(on, opts)
      await $.session.start({ cwd: ROOT, ...session })
      let settled = false
      const pending = $.tool.call({ tool: 'Write', file_path: '/repo/new.ts', content: 'new file' } as never).then(result => { settled = true; return result })
      try {
        await gatePause(50)
        expect(settled).toBe(true)
        expect((await pending).deny).toBe('Pantheon edit gate requires an interactive session to confirm this edit. Edit denied.')
        expect(host.polls()).toBe(0)
        expect(host.forwarded).toEqual([])
      } finally { opts.interrupt = true; await pending }
    })
  }
  const pathStat = (realPath: string): FsStat => ({ kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath })
  const missingPath = () => Object.assign(new Error('ENOENT: missing path'), { code: 'ENOENT' })
  test('parent traversal after a missing component enters recovery instead of exempting an unseen symlink', async () => {
    const target = '/repo/.pantheon/missing/../escape/new.ts'
    const stat = async (path: string): Promise<FsStat> => {
      if (path === '/repo/.pantheon/missing' || path.startsWith('/repo/.pantheon/missing/')) throw missingPath()
      if (path === '/repo/.pantheon/escape') return { ...pathStat('/repo/src'), isLink: true }
      return pathStat(path)
    }
    let held = false
    const result = await withGateRecovery(async () => {
      const path = await resolveGatePath(stat, target, ROOT)
      const context = gateContext({ ...gateEdit, file_path: path }, { root: ROOT, home: HOME })
      return context.skip ? undefined : { deny: 'evaluated' }
    }, async () => ({ result: 'unexpected forwarding' }), async () => {
      held = true
      return { deny: 'held for the person' }
    })
    expect(held).toBe(true)
    expect(result).toEqual({ deny: 'held for the person' })
  })
  test('host-resolved parent traversal before the missing suffix still works', async () => {
    const stat = async (path: string): Promise<FsStat> => {
      if (path.endsWith('/new.ts')) throw missingPath()
      if (path === '/repo/sub/../.pantheon/plans') return pathStat('/repo/.pantheon/plans')
      throw new Error('Unexpected ancestor')
    }
    expect(await resolveGatePath(stat, '../.pantheon/plans/new.ts', '/repo/sub')).toBe('/repo/.pantheon/plans/new.ts')
  })
  test('a plain new subdirectory under .pantheon/plans remains exempt', async () => {
    const stat = async (path: string): Promise<FsStat> => {
      if (path === '/repo/.pantheon/plans/new' || path.endsWith('/new/note.md')) throw missingPath()
      return pathStat(path)
    }
    const path = await resolveGatePath(stat, '/repo/.pantheon/plans/new/note.md', ROOT)
    expect(path).toBe('/repo/.pantheon/plans/new/note.md')
    expect(gateContext({ ...gateEdit, file_path: path }, { root: ROOT, home: HOME }).skip).toBe(true)
  })
  // Hook refusals are not filesystem errors. Inject the filesystem boundary directly
  // to exercise actual ENOENT/code semantics; the UI tests below cover host refusals.
  for (const code of ['EACCES', 'EPERM', 'EIO', 'ELOOP', 'unknown']) {
    test(`resolver never climbs past a middle component with ${code}`, async () => {
      const visited: string[] = []
      const stat = async (path: string): Promise<FsStat> => {
        visited.push(path)
        if (path === '/repo/.pantheon/middle/new.ts') throw missingPath()
        if (path === '/repo/.pantheon/middle') throw Object.assign(new Error(`${code}: host failure`), { code })
        return pathStat(path)
      }
      await expect(resolveGatePath(stat, '/repo/.pantheon/middle/new.ts', ROOT)).rejects.toThrow(code)
      expect(visited.includes('/repo/.pantheon')).toBe(false)
    })
  }
  for (const returnsLink of [false, true]) {
    test(`resolver refuses an unresolved symlink (${returnsLink ? 'stat returns link' : 'resolution throws ENOENT'})`, async () => {
      const visited: boolean[] = []
      const stat = async (_path: string, resolve: boolean): Promise<FsStat> => {
        visited.push(resolve)
        if (resolve && !returnsLink) throw missingPath()
        return { kind: 'other', size: 0, mtimeMs: 0, isLink: true }
      }
      await expect(resolveGatePath(stat, '/repo/.pantheon/new.ts', ROOT)).rejects.toThrow()
      expect(visited).toEqual(returnsLink ? [true] : [true, false])
    })
  }
  for (const failure of ['EACCES: permission denied', 'EPERM: operation denied', 'host unavailable', 'dangling link', 'ELOOP: symlink chain cycle']) {
    test(`path resolution holds on ${failure}`, { options: { gate: true, jevApiKey: 'key', abovePrompt: false } }, async ($, on) => {
      const link = failure === 'dangling link'
      const target = link ? '/repo/.pantheon/new.ts' : '/repo/.pantheon/middle/new.ts'
      const opts = {
        interrupt: false,
        statErrors: link ? {} : { [target]: failure },
        unresolvedLinks: link ? [target] : [],
      }
      const host = gateWorld(on, opts)
      await start($)
      const ui = await $.ui.mount({ plugin: 'pantheon', component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 120 } as never })
      const pending = $.tool.call({ ...gateEdit, file_path: target } as never)
      try {
        await gatePause(50)
        expect(host.forwarded).toEqual([])
        expect(host.sent).toEqual([])
        expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
        expect(host.inspected.some(call => call.path === '/repo/.pantheon')).toBe(false)
        await ui.press({ key: 'cancel' })
        expect((await pending).deny).toContain('Cancel')
      } finally { opts.interrupt = true; await pending; await ui.unmount() }
    })
  }
  test('deep missing paths inherit only a confirmed resolved directory and clean paths keep working', async () => {
    const paths: Record<string, string | undefined> = {
      '/repo/.pantheon/new/deep/a.ts': undefined, '/repo/.pantheon/new/deep': undefined, '/repo/.pantheon/new': undefined,
      '/repo/link/new/deep/a.ts': undefined, '/repo/link/new/deep': undefined, '/repo/link/new': undefined,
      '/repo/link': '/repo/src',
      '/repo/sub/../src/a.ts': '/repo/src/a.ts',
      // The host follows every hop; the gate receives the chain's final destination.
      '/repo/.pantheon/chain.ts': '/repo/src/a.ts',
    }
    const inspected: { path: string; resolve: boolean }[] = []
    const stat = async (path: string, resolve: boolean): Promise<FsStat> => {
      inspected.push({ path, resolve })
      const realPath = Object.hasOwn(paths, path) ? paths[path] : path
      if (realPath === undefined) throw missingPath()
      return { ...pathStat(realPath), isLink: path !== realPath }
    }
    const context = async (path: string) => gateContext({ ...gateEdit, file_path: await resolveGatePath(stat, path, '/repo/sub') }, { root: ROOT, home: HOME })
    expect((await context('/repo/.pantheon/new/deep/a.ts')).skip).toBe(true)
    for (const file_path of ['/repo/link/new/deep/a.ts', '../src/a.ts', '/repo/src/a.ts', '/repo/.pantheon/chain.ts']) {
      expect((await context(file_path)).skip).toBe(false)
    }
    expect(inspected).toContainEqual({ path: '/repo/.pantheon/new/deep/a.ts', resolve: false })
  })
  test('only exact state and scratchpad exemptions bypass the gate and uid is cached', { options: { gate: true, jevApiKey: 'key' } }, async ($, on) => {
    const host = gateWorld(on, { score: 0 })
    const exempt = ['/repo/.pantheon/a.md', `${HOME}/.claude/plans/a.md`, `${HOME}/.claude/projects/repo/memory/a.md`, '/tmp/claude-501/repo/session/scratchpad/a.ts', '/private/tmp/claude-501/repo/session/scratchpad/a.ts']
    for (const file_path of exempt) expect((await $.tool.call({ ...gateEdit, file_path } as never)).deny).toBeUndefined()
    expect(host.sent).toEqual([])
    const gated = ['settings.json', 'CLAUDE.md', 'hooks/a.ts', 'mods/a.ts', 'skills/a.ts', 'plugins/a.ts'].map(p => `${HOME}/.claude/${p}`)
    gated.push('/tmp/claude-502/repo/session/scratchpad/a.ts', '/tmp/claude-501/session/scratchpad/a.ts', '/tmp/claude-501/a.ts')
    for (const file_path of gated) expect((await $.tool.call({ ...gateEdit, file_path } as never)).deny).toContain('Denied by jev')
    expect(host.sent).toHaveLength(gated.length)
    expect(host.uidReads()).toBe(1)
  })
  test('uid lookup failure is cached and grants no scratchpad exemption', { options: { gate: true, jevApiKey: 'key' } }, async ($, on) => {
    const host = gateWorld(on, { score: 0, uid: null })
    for (let i = 0; i < 2; i++) expect((await $.tool.call({ ...gateEdit, file_path: '/tmp/claude-501/repo/session/scratchpad/a.ts' } as never)).deny).toContain('Denied by jev')
    expect(host.uidReads()).toBe(1)
    expect(host.sent).toHaveLength(2)
  })
  test('resolved symlink targets are gated', { options: { gate: true, jevApiKey: 'key' } }, async ($, on) => {
    const host = gateWorld(on, { score: 0, realPaths: {
      '/repo/.pantheon/source.ts': '/repo/src/source.ts',
      [`${HOME}/.claude/plans/source.ts`]: '/repo/src/source.ts',
    } })
    for (const file_path of ['/repo/.pantheon/source.ts', `${HOME}/.claude/plans/source.ts`]) {
      expect((await $.tool.call({ ...gateEdit, file_path } as never)).deny).toContain('Denied by jev')
    }
    expect(host.sent).toHaveLength(2)
    expect(host.forwarded).toEqual([])
  })
  test('relative paths use session cwd rather than repository root', { options: { gate: true, jevApiKey: 'key' } }, async ($, on) => {
    const host = gateWorld(on, { score: 0, cwd: '/repo/sub', realPaths: { '/repo/sub/../.pantheon/note.md': '/repo/.pantheon/note.md' } })
    expect((await $.tool.call({ ...gateEdit, file_path: '.pantheon/note.md' } as never)).deny).toContain('Denied by jev')
    expect((await $.tool.call({ ...gateEdit, file_path: '../.pantheon/note.md' } as never)).deny).toBeUndefined()
    expect(host.sent).toHaveLength(1)
  })
  for (const fault of ['workspace', 'env'] as const) {
    test(`${fault} failure asks instead of running the edit`, { options: { gate: true, jevApiKey: 'key', abovePrompt: false } }, async ($, on) => {
      const opts = { fault, interrupt: false }
      const host = gateWorld(on, opts)
      await start($)
      const ui = await $.ui.mount({ plugin: 'pantheon', component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 120 } as never })
      const pending = $.tool.call(gateEdit as never)
      try {
        await gatePause(50)
        expect(host.forwarded).toEqual([])
        expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
        expect((await ui.findAll({ type: 'Text' })).map(n => n.text).join('')).not.toContain('private')
        await ui.press({ key: 'cancel' })
        expect((await pending).deny).toContain('Cancel')
      } finally { opts.interrupt = true; await pending; await ui.unmount() }
    })
  }
  test('a thrown decision asks and a failed recovery denies', async () => {
    const throwingDecision = async () => { throw new Error('private decision error') }
    let asks = 0
    const ask = async () => { asks++; return { deny: 'held and cancelled' } }
    expect(await withGateRecovery(throwingDecision, async () => ({ result: 'unused' }), ask)).toEqual({ deny: 'held and cancelled' })
    expect(asks).toBe(1)
    expect(await withGateRecovery(throwingDecision, async () => ({ result: 'unused' }), throwingDecision)).toEqual({ deny: 'Pantheon edit gate could not obtain a decision. Edit denied.' })
    expect(asks).toBe(1)
  })
  for (const gate of [false, true]) {
    test(`forwarding rejection runs next once and never opens recovery (gate=${gate})`, async () => {
      let calls = 0
      let holds = 0
      const next = async () => { calls++; throw new Error('downstream rejected') }
      await expect(withGateRecovery(async () => { if (gate) holds++; return undefined }, next, async () => {
        holds++
        return undefined
      })).rejects.toThrow('downstream rejected')
      expect(calls).toBe(1)
      expect(holds).toBe(gate ? 1 : 0)
    })
  }
  for (const reverse of [false, true]) {
    test(`parallel holds keep the second notice after delayed cleanup (${reverse})`, { options: { gate: true, jevApiKey: 'key', abovePrompt: false } }, async ($, on) => {
      const opts = { score: 0.5, interrupt: false }
      const host = gateWorld(on, opts)
      let delayed = false
      let ready = false
      on('state.set', async (_$, e, next) => {
        if (ready && e.key === 'gateHeld' && e.value === null && !delayed) { delayed = true; await gatePause(80) }
        return next(e)
      })
      await start($)
      ready = true
      const ui = await $.ui.mount({ plugin: 'pantheon', component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 120 } as never })
      const first = $.tool.call({ ...gateEdit, tool_use_id: reverse ? 'b' : 'a' } as never)
      await gatePause(30)
      const second = $.tool.call({ ...gateEdit, tool_use_id: reverse ? 'a' : 'b' } as never)
      try {
        await gatePause(30)
        await ui.press({ key: reverse ? 'proceed' : 'cancel' })
        await first
        await gatePause(30)
        expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
        await ui.press({ key: reverse ? 'cancel' : 'proceed' })
        const result = await second
        expect(Boolean(result.deny)).toBe(reverse)
        expect(host.forwarded).toHaveLength(1)
      } finally {
        opts.interrupt = true
        await Promise.all([first, second])
        await ui.unmount()
      }
    })
  }
  for (const options of [{}, { gate: false }]) {
    test(`disabled gate passes untouched ${JSON.stringify(options)}`, { options }, async ($, on) => {
      const host = gateWorld(on)
      expect(await $.tool.call(gateEdit as never)).toEqual({ result: 'unchanged' })
      expect(host.forwarded).toEqual([gateEdit])
      expect(host.sent).toEqual([])
      expect(host.probes()).toBe(0)
    })
  }
  test('allows all edit tools, sends metadata only, prefers the option key and reuses the root', { options: { gate: true, jevApiKey: 'option-key' } }, async ($, on) => {
    const host = gateWorld(on, { key: 'env-key' })
    await start($)
    const probes = host.probes()
    for (const event of [gateEdit, { tool: 'Write', file_path: '/repo/a.ts', content: 'private content' }, { tool: 'NotebookEdit', notebook_path: '/repo/a.ipynb', new_source: 'private source' }]) {
      expect(await $.tool.call(event as never)).toEqual({ result: 'unchanged' })
    }
    expect(host.forwarded).toHaveLength(3)
    expect(host.probes()).toBe(probes)
    expect(host.sent).toHaveLength(3)
    for (const request of host.sent) {
      expect(request.headers?.Authorization).toBe('Bearer option-key')
      for (const secret of ['old_string', 'new_string', 'content', 'new_source', 'private']) expect(request.body).not.toContain(secret)
    }
    expect(JSON.parse(host.sent[0].body!).state).toEqual({ tool: 'Edit', kind: 'source', ext: 'ts', linesAdded: 1, linesRemoved: 1, files: 1, caller: 'main orchestrator session' })
  })
  test('denies a low score and uses the environment key when the option is blank', { options: { gate: true, jevApiKey: '  ' } }, async ($, on) => {
    const host = gateWorld(on, { key: 'env-key', score: 0.1 })
    expect((await $.tool.call(gateEdit as never)).deny).toContain('delegate to the executor')
    expect(host.forwarded).toEqual([])
    expect(host.sent[0].headers?.Authorization).toBe('Bearer env-key')
  })
  test('skips subagents and exempt directories without requests', { options: { gate: true, jevApiKey: 'key' } }, async ($, on) => {
    const host = gateWorld(on)
    for (const event of [{ ...gateEdit, agentId: 'native-1' }, ...['/repo/.pantheon/plan.md', `${HOME}/.claude/plans/note.md`, '/private/tmp/claude-501/repo/session/scratchpad/a.ts', '/tmp/claude-501/repo/session/scratchpad/a.ts'].map(file_path => ({ ...gateEdit, file_path }))]) {
      expect((await $.tool.call(event as never)).deny).toBeUndefined()
    }
    expect(host.sent).toEqual([])
    expect(host.forwarded).toHaveLength(5)
  })
  for (const reject of [false, true]) {
    test(`local rules survive ${reject ? 'a rejected fetch' : 'a missing key'}`, { options: { gate: true } }, async ($, on) => {
      const host = gateWorld(on, { reject, key: reject ? 'key' : undefined })
      expect((await $.tool.call(gateEdit as never)).deny).toBeUndefined()
      expect((await $.tool.call({ ...gateEdit, new_string: 'line\n'.repeat(110) } as never)).deny).toContain('Denied by rules')
      expect(host.sent).toHaveLength(reject ? 2 : 0)
      expect(host.forwarded).toHaveLength(1)
    })
  }
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`grey zone waits for Proceed or Cancel on ${surface}`, { options: { gate: true, jevApiKey: 'key', abovePrompt: false } }, async ($, on) => {
      const host = gateWorld(on, { score: 0.5 })
      await $.session.start({ cwd: ROOT, surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'pantheon', component: 'AbovePrompt', surface, props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} } })
      for (const decision of ['cancel', 'proceed']) {
        const pending = $.tool.call(gateEdit as never)
        await gatePause(50)
        expect(host.forwarded).toHaveLength(0)
        expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
        await ui.press({ key: decision })
        const result = await pending
        if (decision === 'cancel') expect(result.deny).toContain('pressed Cancel')
        else expect(result).toEqual({ result: 'unchanged' })
        expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
      }
      expect(host.forwarded).toHaveLength(1)
      await ui.unmount()
    })
  }
  test('a failed hold denies instead of letting the edit through', { options: { gate: true, jevApiKey: 'key' } }, async ($, on) => {
    const host = gateWorld(on, { score: 0.5, interrupt: true })
    await start($)
    expect((await $.tool.call(gateEdit as never)).deny).toContain('interrupted')
    expect(host.forwarded).toEqual([])
  })
  test('disabled roles are not recommended', { options: { gate: true, jevApiKey: 'key' } }, async ($, on) => {
    gateWorld(on, { score: 0.1, files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ disabledAgents: ['executor', 'designer'] }) } })
    await start($)
    const result = await $.tool.call({ ...gateEdit, file_path: '/repo/view.tsx' } as never)
    expect(result.deny).toContain('ask the person to handle implementation')
    expect(result.deny).toContain('ask the person to handle UI work')
  })
  test('rules hold unknown edits and receipt counts only the edit that proceeds', { options: { gate: true } }, async ($, on) => {
    const host = gateWorld(on)
    mock.store(on)
    on('session.id', () => ({ value: 'gate-session' }))
    on('session.model', () => ({ value: 'claude-opus-5' }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 1000, percent: 0 }, rateLimits: [] } }))
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: 'Completed' }))
    await start($)
    await $.turn.start({ turnId: 'gate-turn', prompt: 'Edit' } as never)
    const ui = await $.ui.mount({ plugin: 'pantheon', component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 120 } as never })
    expect((await $.tool.call({ ...gateEdit, new_string: 'line\n'.repeat(110) } as never)).deny).toContain('Denied by rules')
    for (const decision of ['cancel', 'proceed']) {
      const pending = $.tool.call({ tool: 'Write', file_path: '/repo/new.ts', content: 'unknown old size' } as never)
      await gatePause(50)
      expect(host.forwarded).toHaveLength(0)
      expect((await ui.findAll({ type: 'Text' })).map(n => n.text).join('|')).toContain('by rules')
      await ui.press({ key: decision })
      await pending
    }
    await $.turn.complete({ turnId: 'gate-turn', reason: 'answer', answer: 'Done', durationMs: 1000, isAborted: false })
    expect((await ui.findAll({ type: 'Text' })).map(n => n.text).join('')).toContain('last turn 1s · 0 agents · 1 edit · 0 errors')
    expect(host.sent).toEqual([])
    await ui.unmount()
  })
})

function trackingWorld(on: On, slowNativeWrite = false, opts: {
  chunk?: boolean; slowMs?: number
  /** While it returns a promise, every natives write waits for it. */
  hold?: () => Promise<void> | undefined
} = {}) {
  const fixture = world(on)
  const forwarded: string[] = []
  on('agent.spawn', async () => ({ model: 'model-1', agentId: 'native-1' }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    forwarded.push(e.turnId)
    if (opts.chunk) {
      yield streamChunk
      // The response takes time to finish streaming.
      if (opts.slowMs) await fixture.clock.sleep(opts.slowMs)
    }
    return { ...stepResult, turnId: e.turnId, index: e.index }
  })
  on('turn.complete', async () => ({ text: 'Completed' }))
  on('session.measure', async () => ({ changed: ['context'] }))
  on('tool.call', async () => ({ result: 'Tool result' }))
  const stored: Record<string, unknown> = {}
  const writes: number[] = []
  let slowed = false
  on('state.set', async (_$, e, next) => {
    const steps = e.key === 'natives' ? (e.value as Native[])[0]?.steps ?? 0 : undefined
    // Only the first write of one step is slow: the next steps' writes then wait behind it.
    if (slowNativeWrite && steps === 1 && !slowed) { slowed = true; await fixture.clock.sleep(10) }
    if (steps !== undefined) await opts.hold?.()
    const result = await next(e)
    if (result.value.isSet) {
      stored[e.key] = e.value
      if (steps !== undefined) writes.push(steps)
    }
    return result
  })
  on('command.run', { command: 'tracking-state' }, async (_$, e) => {
    return { text: JSON.stringify(stored[e.args] ?? null) }
  })
  return { ...fixture, writes, forwarded }
}
async function nativesOf($: Engine): Promise<Native[]> {
  return JSON.parse((await $.command.run({ command: 'tracking-state', args: 'natives' })).text ?? 'null') ?? []
}
async function sessionOf($: Engine): Promise<SessionInfo | undefined> {
  return JSON.parse((await $.command.run({ command: 'tracking-state', args: 'session' })).text ?? 'null')
}
async function step($: Engine, input = stepInput()) {
  const stream = $.turn.step(input)
  const chunks = []
  let item = await stream.next()
  while (!item.done) { chunks.push(item.value); item = await stream.next() }
  return { chunks, result: item.value }
}

describe('register', () => {
  const commonDirArgv = [
    'env', '-u', 'GIT_DIR', '-u', 'GIT_COMMON_DIR', '-u', 'GIT_WORK_TREE',
    '-u', 'GIT_INDEX_FILE', '-u', 'GIT_OBJECT_DIRECTORY', '-u', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    '-u', 'GIT_CEILING_DIRECTORIES', '-u', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
    'git', 'rev-parse', '--path-format=absolute', '--git-common-dir',
  ]
  const commonDirCommand = commonDirArgv.join(' ')

  for (const foreign of [false, true]) {
    test(`git ${foreign ? 'refuses a foreign nested repository' : 'allows a linked worktree with the same canonical common dir'}`, async ($, on) => {
      const { seen } = world(new Proxy(on, {
        apply(target, thisArg, args) {
          if (args[0] !== 'process.run') return Reflect.apply(target, thisArg, args)
        },
      }), {
        realPaths: { '/repo/link': '/repo/sub', '/main/link.git': '/main/.git' },
      })
      const cwds: (string | undefined)[] = []
      on('process.run', async (_$, e) => {
        const common = e.argv.includes('--git-common-dir') && !e.argv.includes('--git-dir')
        if (common) {
          expect(e.argv).toEqual(commonDirArgv)
          cwds.push(e.init?.cwd)
        }
        const dir = e.init?.cwd === ROOT ? '/main/.git' : foreign ? '/foreign/.git' : '/main/link.git'
        return { value: {
          exitCode: 0, stdout: common ? `${dir}\n` : `${ROOT}\n`, stderr: '',
          isStdoutTruncated: false, isStderrTruncated: false,
        } }
      })
      await start($)
      const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'git', prompt: 't', cwd: '/repo/link' } as never))
      expect(cwds).toEqual([ROOT, '/repo/sub'])
      if (foreign) {
        expect(out.error).toContain("does not belong to the session's repository")
        expect(seen.argv).toEqual([])
        return
      }
      expect(out.error).toBeUndefined()
      expect(seen.argv.length).toBe(1)
      expect(seen.argv[0]).toContain('sandbox_workspace_write.writable_roots=["/main/.git"]')
      expect(seen.argv[0]).toContain('sandbox_workspace_write.network_access=true')
    })
  }

  for (const [setting, patch] of [
    ['sandboxCap', { sandboxCap: 'read-only' }],
    ['noNetwork', { noNetwork: true }],
    ['sandbox', { agents: { git: { sandbox: 'read-only' } } }],
  ] as const) {
    test(`git refuses ${setting} without spawning`, async ($, on) => {
      const { seen } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ profile: 'codex', ...patch }) } })
      await start($)
      const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'git', prompt: 't' } as never))
      expect(out.error).toContain(setting)
      expect(seen.argv).toEqual([])
    })
  }

  test('git refuses a failed rev-parse without spawning', async ($, on) => {
    const { seen } = world(on, { runs: { [commonDirCommand]: { exitCode: 128 } } })
    await start($)
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'git', prompt: 't' } as never))
    expect(out.error).toContain('git common dir could not be resolved')
    expect(seen.argv).toEqual([])
  })

  const mountPanel = ($: Engine) => $.ui.mount({
    plugin: 'pantheon', surface: 'terminal', component: 'Pane', requestId: PANE_ID,
    props: { title: 'Pantheon', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } },
    viewport: { columns: 120, rows: 40 },
  })

  for (const layer of ['user', 'project'] as const) {
    test(`panel reloads the ${layer} JSON profile, names and lock between renders without a prompt`, async ($, on) => {
      const { files, seen } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{}' } })
      const first = await mountPanel($)
      try {
        expect((await first.find({ key: 'profile' }))?.props.value).toBe('claude')
      } finally { await first.unmount() }
      const path = layer === 'user' ? `${HOME}/.claude/pantheon.json` : `${ROOT}/.claude/pantheon.json`
      files[path] = JSON.stringify({ profile: 'personal', profiles: { personal: {} } })
      const second = await mountPanel($)
      try {
        expect(await second.find({ type: 'Text', text: '● personal' })).toBeDefined()
        expect(await second.find({ type: 'Text', text: `set by ${layer} pantheon.json` })).toBeDefined()
        expect(await second.find({ type: 'Select', key: 'profile' })).toBeUndefined()
      } finally { await second.unmount() }
      delete files[path]
      const third = await mountPanel($)
      try {
        const select = await third.find({ key: 'profile' })
        expect(select?.props.value).toBe('claude')
        expect((select?.props.options as { value: string }[]).map(option => option.value)).toEqual(['claude', 'codex', 'mixed'])
      } finally { await third.unmount() }
      expect(seen.agents.length).toBe(24)
    })
  }

  test('panel reads options.profile on the first render without session.start or a prompt', { options: { profile: 'codex' } }, async ($, on) => {
    world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{}' } })
    const ui = await mountPanel($)
    try {
      expect((await ui.find({ key: 'profile' }))?.props.value).toBe('codex')
      expect(await ui.find({ type: 'Text', text: /set by .* pantheon.json/ })).toBeUndefined()
    } finally { await ui.unmount() }
  })

  test('panel keeps the last valid profile and warns once across invalid JSON renders without invalidating itself', async ($, on) => {
    const { files, seen } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{"profile":"mixed"}' } })
    const invalidations: string[] = []
    on('ui.invalidate', async (_$, e) => { invalidations.push(e.event); return { value: undefined } })
    const first = await mountPanel($)
    try { expect(await first.find({ type: 'Text', text: '● mixed' })).toBeDefined() }
    finally { await first.unmount() }
    files[`${HOME}/.claude/pantheon.json`] = '{ broken'
    for (let i = 0; i < 2; i++) {
      const ui = await mountPanel($)
      try {
        const selected = await ui.find({ key: 'profile' })
        const locked = await ui.find({ type: 'Text', text: '● mixed' })
        expect(selected?.props.value === 'mixed' || locked !== undefined).toBe(true)
      } finally { await ui.unmount() }
    }
    expect(seen.toasts).toEqual([`pantheon: invalid config — ${HOME}/.claude/pantheon.json: Invalid JSON`])
    expect(seen.agents.length).toBe(3)
    expect(invalidations).toEqual([])
  })

  test('panel selection requests a redraw after a successful config.set', async ($, on) => {
    world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{}' } })
    const invalidations: string[] = []
    const writes: { key: string; value: unknown }[] = []
    on('config.set', async (_$, e) => { writes.push({ key: e.key, value: e.value }); return { value: e.value } })
    on('ui.invalidate', async (_$, e) => { invalidations.push(e.event); return { value: undefined } })
    await start($)
    const ui = await mountPanel($)
    try {
      await ui.select({ key: 'profile', value: 'codex' })
      expect(writes).toEqual([{ key: 'pantheon.profile', value: 'codex' }])
      expect(invalidations).toEqual(['ui.render'])
    } finally { await ui.unmount() }
  })

  test('panel selection denies user JSON that became invalid since the render without writing or invalidating', async ($, on) => {
    const { files, seen } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{}' } })
    const writes: ConfigSetInput[] = []
    const invalidations: string[] = []
    on('config.set', async (_$, e) => { writes.push(e); return { value: e.value } })
    on('ui.invalidate', async (_$, e) => { invalidations.push(e.event); return { value: undefined } })
    const ui = await mountPanel($)
    try {
      files[`${HOME}/.claude/pantheon.json`] = '{ broken'
      await ui.select({ key: 'profile', value: 'mixed' })
      expect(writes).toEqual([])
      expect(invalidations).toEqual([])
      expect(seen.toasts).toEqual([`pantheon: ${HOME}/.claude/pantheon.json: Invalid JSON`])
    } finally { await ui.unmount() }
  })

  test('panel selection denies a custom profile removed from project JSON since the render without writing or invalidating', async ($, on) => {
    const { files, seen } = world(on, { files: {
      [`${HOME}/.claude/pantheon.json`]: '{}',
      [`${ROOT}/.claude/pantheon.json`]: '{"profiles":{"personal":{}}}',
    } })
    const writes: ConfigSetInput[] = []
    const invalidations: string[] = []
    on('config.set', async (_$, e) => { writes.push(e); return { value: e.value } })
    on('ui.invalidate', async (_$, e) => { invalidations.push(e.event); return { value: undefined } })
    const ui = await mountPanel($)
    try {
      files[`${ROOT}/.claude/pantheon.json`] = '{}'
      await ui.select({ key: 'profile', value: 'personal' })
      expect(writes).toEqual([])
      expect(invalidations).toEqual([])
      expect(seen.toasts).toEqual(['pantheon: unknown profile "personal"; known: claude, codex, mixed'])
    } finally { await ui.unmount() }
  })

  const profileChange = (value: string): ConfigSetInput => ({
    key: 'pantheon.profile', value, previous: 'claude',
    provider: { plugin: 'pantheon', tier: 'user' }, origin: { kind: 'composer' },
  })

  test('config.set allows a built-in profile unchanged', async ($, on) => {
    world(on)
    const received: ConfigSetInput[] = []
    on('config.set', async (_$, e) => { received.push(e); return { value: e.value } })
    const input = profileChange('codex')
    expect(await $.config.set(input)).toEqual({ value: 'codex' })
    expect(received).toEqual([input])
  })

  for (const path of [`${HOME}/.claude/pantheon.json`, `${ROOT}/.claude/pantheon.json`]) {
    test(`config.set allows a custom profile freshly defined in ${path}`, async ($, on) => {
      const { files } = world(on)
      on('config.set', async (_$, e) => ({ value: e.value }))
      await start($)
      files[path] = JSON.stringify({ profiles: { custom: {} } })
      expect(await $.config.set(profileChange('custom'))).toEqual({ value: 'custom' })
    })
  }

  test('config.set denies an unknown profile with the merged known names even when JSON selects a profile', async ($, on) => {
    world(on, { files: {
      [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ profile: 'claude', profiles: { personal: {} } }),
      [`${ROOT}/.claude/pantheon.json`]: JSON.stringify({ profiles: { project: {} } }),
    } })
    const received: ConfigSetInput[] = []
    on('config.set', async (_$, e) => { received.push(e); return { value: e.value } })
    expect(await $.config.set(profileChange('missing'))).toEqual({
      deny: 'unknown profile "missing"; known: claude, codex, mixed, personal, project',
    })
    expect(received).toEqual([])
  })

  for (const cleared of ['', '  ']) {
    test(`config.set with ${JSON.stringify(cleared)} clears the selection and reaches next`, async ($, on) => {
      world(on)
      const received: ConfigSetInput[] = []
      on('config.set', async (_$, e) => { received.push(e); return { value: e.value } })
      const input = profileChange(cleared)
      expect(await $.config.set(input)).toEqual({ value: cleared })
      expect(received).toEqual([input])
    })
  }

  test('config.set denies malformed user JSON after a valid config without calling next', async ($, on) => {
    const { files } = world(on)
    const received: ConfigSetInput[] = []
    on('config.set', async (_$, e) => { received.push(e); return { value: e.value } })
    await start($)
    files[`${HOME}/.claude/pantheon.json`] = '{ broken'
    expect(await $.config.set(profileChange('mixed'))).toEqual({
      deny: `${HOME}/.claude/pantheon.json: Invalid JSON`,
    })
    expect(received).toEqual([])
  })

  test('config.set denies a custom profile with a mismatched model without calling next', async ($, on) => {
    const { files } = world(on)
    const received: ConfigSetInput[] = []
    on('config.set', async (_$, e) => { received.push(e); return { value: e.value } })
    await start($)
    files[`${HOME}/.claude/pantheon.json`] = JSON.stringify({
      profiles: { custom: { agents: { executor: { engine: 'codex', model: 'sonnet' } } } },
    })
    expect(await $.config.set(profileChange('custom'))).toEqual({
      deny: `${HOME}/.claude/pantheon.json: profiles.custom.agents.executor.model: "sonnet" is a Claude model (engine codex)`,
    })
    expect(received).toEqual([])
  })

  test('config.set passes another config row through unchanged', async ($, on) => {
    world(on)
    const received: ConfigSetInput[] = []
    on('config.set', async (_$, e) => { received.push(e); return { value: e.value } })
    const input: ConfigSetInput = {
      key: 'theme', value: 'light', previous: 'dark',
      provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' },
    }
    expect(await $.config.set(input)).toEqual({ value: 'light' })
    expect(received).toEqual([input])
  })

  for (const profile of ['codex', 'mixed']) {
    test(`options.profile selects ${profile} on load when JSON has no selection`, { options: { profile } }, async ($, on) => {
      world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{}' } })
      await start($)
      const report = await $.command.run({ command: 'pantheon', args: 'config' })
      expect(report.text).toContain(`Active profile: ${profile} (settings)`)
    })
  }

  for (const [path, origin] of [[`${HOME}/.claude/pantheon.json`, 'user'], [`${ROOT}/.claude/pantheon.json`, 'project']] as const) {
    test(`options.profile overrides the ${origin} JSON profile`, { options: { profile: 'codex' } }, async ($, on) => {
      world(on, { files: { [path]: JSON.stringify({ profile: 'claude' }) } })
      await start($)
      const report = await $.command.run({ command: 'pantheon', args: 'config' })
      expect(report.text).toContain('Active profile: codex (settings)')
    })
  }

  for (const failedKeys of [['natives'], ['session'], ['view'], ['natives', 'session', 'view']]) {
    test(`failed panel writes warn once and preserve hook results: ${failedKeys.join(', ')}`, async ($, on) => {
      const { seen } = world(on)
      const rejected: string[] = []
      on('state.set', async (_$, e, next) => {
        if (!failedKeys.includes(e.key)) return next(e)
        rejected.push(e.key)
        return { deny: 'panel storage unavailable' }
      })
      const spawned = { agentId: 'native-1', model: 'model-1' }
      const completed = { text: 'unchanged completion' }
      const called = { ref: 9, result: 'unchanged tool result', text: 'Tool text', isReadOnly: true as const }
      on('agent.spawn', async () => spawned)
      on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
      on('turn.complete', async () => completed)
      on('tool.call', async () => called)
      on('turn.step', async function* () { return stepResult })
      on('session.measure', async () => ({ changed: ['context'] }))
      expect(await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })).toEqual({ cwd: ROOT })
      expect(await $.turn.start({ text: 'Go', turnId: 'turn-1' })).toEqual({ turnId: 'turn-1' })
      expect(await $.agent.spawn(spawnInput)).toEqual(spawned)
      expect((await step($)).result).toEqual(stepResult)
      expect(await $.tool.call({ tool: 'Bash', command: 'pwd', agentId: 'native-1' })).toEqual(called)
      expect(await $.turn.complete({ ...completeInput, agentId: 'native-1' })).toEqual(completed)
      expect(await $.turn.complete(completeInput)).toEqual(completed)
      expect(await $.session.measure(measureInput)).toEqual({ changed: ['context'] })
      // Repeat view writes as well as the queue writes: the warning stays session-wide.
      await start($)
      for (const key of failedKeys) expect(rejected.filter(value => value === key).length).toBeGreaterThan(1)
      expect(seen.toasts.length).toBe(1)
      expect(seen.toasts[0]).toContain('pantheon: could not save the panel state (the panel may be stale):')
      expect(seen.toasts[0]).toContain('panel storage unavailable')
    })
  }

  test('snapshot queues recover after a failed write and retain only the latest pending snapshot', async () => {
    const writes: number[] = []
    const errors: unknown[] = []
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let began!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    const failure = new Error('write failed')
    const queue = createQueue<number>(async value => {
      writes.push(value)
      if (value === 1) { began(); await held; throw failure }
    }, error => { errors.push(error) })
    queue.push(1)
    await started
    queue.push(2)
    queue.push(3)
    release()
    await queue.flushed()
    expect(writes).toEqual([1, 3])
    expect(errors).toEqual([failure])
    queue.push(4)
    await queue.flushed()
    expect(writes).toEqual([1, 3, 4])
  })

  test('a queue with a merge keeps every waiting action, in order', async () => {
    const order: string[] = []
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let began!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    type Job = () => Promise<unknown>
    const queue = createQueue<Job>(write => write(), () => {}, (a, b) => async () => { await a(); await b() })
    queue.push(async () => { order.push('first'); began(); await held })
    await started
    queue.push(async () => { order.push('toggle') })
    queue.push(async () => { order.push('tab') })
    release()
    await queue.flushed()
    expect(order).toEqual(['first', 'toggle', 'tab'])
  })

  test('tracking initializes lazily without session.start and ignores unknown native ids', async ($, on) => {
    trackingWorld(on)
    await step($)
    await $.tool.call({ tool: 'Bash', command: 'pwd', agentId: 'native-1' })
    await $.turn.complete({ ...completeInput, agentId: 'native-1' })
    expect(await nativesOf($)).toEqual([])
    await $.agent.spawn(spawnInput)
    await step($)
    expect((await nativesOf($))[0].steps).toBe(1)
    expect((await nativesOf($))[0].rounds[0].status).toBe('running')
  })

  test('every tracking hook returns the event result unchanged', async ($, on) => {
    world(on)
    const started = { turnId: 'sentinel-turn' }
    const spawned = { model: 'sentinel-model', agentId: 'native-1' }
    const completed = { text: 'sentinel-completed' }
    const measured = { changed: ['cost'] as ['cost'] }
    const called = { ref: 7, result: 'sentinel-tool', text: 'Tool text', isReadOnly: true as const }
    const chunk = { kind: 'text' as const, index: 0, text: 'stream sentinel' }
    on('turn.start', async () => started)
    on('agent.spawn', async () => spawned)
    on('turn.complete', async () => completed)
    on('session.measure', async () => measured)
    on('tool.call', async () => called)
    on('turn.step', async function* () { yield chunk; return stepResult })
    await start($)
    expect(await $.turn.start({ text: 'Go', turnId: 'turn-1' })).toEqual(started)
    expect(await $.agent.spawn(spawnInput)).toEqual(spawned)
    const { chunks, result } = await step($)
    expect(chunks).toEqual([chunk])
    expect(result).toEqual(stepResult)
    expect(await $.turn.complete({ ...completeInput, agentId: 'native-1' })).toEqual(completed)
    expect(await $.session.measure(measureInput)).toEqual(measured)
    expect(await $.tool.call({ tool: 'Bash', command: 'pwd', agentId: 'native-1' })).toEqual(called)
  })

  test('agent.spawn of pantheon:oracle records a native through steps, tools and completion', async ($, on) => {
    trackingWorld(on)
    await start($)
    await $.agent.spawn(spawnInput)
    await step($)
    await $.tool.call({ tool: 'Bash', command: 'pwd', agentId: 'native-1' })
    await $.turn.complete({ ...completeInput, agentId: 'native-1' })
    const [native] = await nativesOf($)
    expect(native.role).toBe('oracle')
    expect(native.rounds[0].status).toBe('done')
    expect(native.rounds[0].turnId).toBe('turn-1')
    expect(native.steps).toBe(1)
    expect(native.ctx).toBe(15)
    expect(native.out).toBe(4)
    expect(native.lastTool).toBe('Bash pwd')
    await step($, { ...stepInput(1), turnId: 'turn-2' })
    expect((await nativesOf($))[0].rounds.map(round => round.status)).toEqual(['done', 'running'])
  })

  test('a native continuation reads running while its step streams, and its usage counts once', async ($, on) => {
    const { clock } = trackingWorld(on, false, { chunk: true, slowMs: 500 })
    await start($)
    await $.agent.spawn(spawnInput)
    const firstStep = step($)
    await clock.settle()
    await clock.advance(500)
    await firstStep
    await $.turn.complete({ ...completeInput, agentId: 'native-1' })
    await clock.advance(1_000)
    const stream = $.turn.step({ ...stepInput(0), turnId: 'turn-2' })
    const first = await stream.next()
    expect(first.value).toEqual(streamChunk)
    const during = (await nativesOf($))[0]
    expect(during.rounds.map(round => round.status)).toEqual(['done', 'running'])
    expect(during.rounds[1].turnId).toBe('turn-2')
    // The step is not counted until its response is in.
    expect(during.steps).toBe(1)
    const pending = stream.next()
    await clock.settle()
    await clock.advance(500)
    const end = await pending
    expect(end.done).toBe(true)
    expect(end.value).toEqual({ ...stepResult, turnId: 'turn-2', index: 0 })
    const after = (await nativesOf($))[0]
    expect(after.rounds[1].startedAt).toBe(during.rounds[1].startedAt)
    expect(after.rounds[1].startedAt).toBeLessThan(clock.now())
    expect(after.rounds.length).toBe(2)
    expect(after.steps).toBe(2)
    expect(after.out).toBe(8)
  })

  test('a held natives write never holds the step: it is forwarded and streams before the write lands', async ($, on) => {
    let gate: Promise<void> | undefined
    let release!: () => void
    const { forwarded } = trackingWorld(on, false, { chunk: true, hold: () => gate })
    await start($)
    await $.agent.spawn(spawnInput)
    await step($)
    await $.turn.complete({ ...completeInput, agentId: 'native-1' })
    gate = new Promise<void>(resolve => { release = resolve })
    const stream = $.turn.step({ ...stepInput(0), turnId: 'turn-2' })
    let arrived = false
    const first = stream.next().then(item => { arrived = true; return item })
    // Let everything not waiting on the held write run.
    for (let k = 0; k < 20; k++) await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(forwarded).toEqual(['turn-1', 'turn-2'])
    expect(arrived).toBe(true)
    expect((await first).value).toEqual(streamChunk)
    // Nothing of turn-2 is persisted while the write is held.
    expect((await nativesOf($))[0].rounds.map(round => round.status)).toEqual(['done'])
    gate = undefined
    release()
    const end = await stream.next()
    expect(end.done).toBe(true)
    expect(end.value).toEqual({ ...stepResult, turnId: 'turn-2', index: 0 })
    const [native] = await nativesOf($)
    expect(native.rounds.map(round => round.status)).toEqual(['done', 'running'])
    expect(native.rounds[1].turnId).toBe('turn-2')
    expect(native.steps).toBe(2)
  })

  test('queued writes land in order for three concurrent steps', async ($, on) => {
    const { clock, writes } = trackingWorld(on, true)
    await start($)
    await $.agent.spawn(spawnInput)
    const first = step($)
    await clock.settle()
    const pending = Promise.all([first, ...[1, 2].map(index => step($, stepInput(index)))])
    await clock.settle()
    await clock.advance(10)
    await pending
    expect((await nativesOf($))[0].steps).toBe(3)
    expect(writes[writes.length - 1]).toBe(3)
    expect(writes).toContain(1)
    expect(writes).toEqual([...writes].sort((a, b) => a - b))
  })

  test('reload marks running native rounds lost and resets the session', async ($, on) => {
    trackingWorld(on)
    const saved: Native[] = [{ id: 'old', role: 'oracle', type: 'pantheon:oracle', task: 'Old', model: 'm',
      rounds: [{ startedAt: 1, status: 'done' }, { startedAt: 2, status: 'running' }], ctx: 0, out: 0, steps: 2 }]
    const served = new Set<string>()
    on('state.get', async (_$, e, next) => {
      if (served.has(e.key) || !['natives', 'session'].includes(e.key)) return next(e)
      served.add(e.key)
      return { value: { value: e.key === 'natives' ? saved : { isRunning: true, model: 'saved-model' }, version: 1 } } as never
    })
    await start($)
    expect((await nativesOf($))[0].rounds.map(round => round.status)).toEqual(['done', 'lost'])
    expect(await sessionOf($)).toEqual({ isRunning: false, model: 'saved-model' })
  })

  test('main session tracks start, model, effort, measurement and completion independently', async ($, on) => {
    trackingWorld(on)
    await start($)
    await $.turn.start({ text: 'Go', turnId: 'turn-1' })
    expect((await sessionOf($))?.isRunning).toBe(true)
    const startedAt = (await sessionOf($))!.turnStartedAt!
    await step($, { ...stepInput(), agentId: undefined, effort: 3 })
    await $.session.measure(measureInput)
    await $.agent.spawn(spawnInput)
    await $.turn.complete({ ...completeInput, agentId: 'native-1' })
    expect((await sessionOf($))?.isRunning).toBe(true)
    await $.turn.complete(completeInput)
    const session = await sessionOf($)
    expect(session?.model).toBe('model-1')
    expect(session?.effort).toBe('3')
    expect(session?.context).toEqual(measureInput.context)
    expect(session?.isRunning).toBe(false)
    expect(session?.lastTurnMs).toBe(42)
    expect(session?.turns).toEqual([{ startedAt, endedAt: startedAt + 42 }])
  })

  test('the panel opens on session.start and /pantheon close closes it', async ($, on) => {
    const { seen } = world(on)
    await start($)
    // The footer says "esc close": both opens close on Escape, and the manual one also focuses.
    expect(seen.opened).toEqual([{ id: 'pantheon', title: 'Pantheon', columns: 72, rows: 8, closeOnEscape: true }])
    expect(await $.command.run({ command: 'pantheon', args: 'close' })).toEqual({ text: 'Pantheon panel closed.' })
    expect(seen.closed).toEqual(['pantheon'])
    await $.command.run({ command: 'pantheon', args: '' })
    expect(seen.opened[1]).toEqual({ id: 'pantheon', title: 'Pantheon', focus: true, closeOnEscape: true })
  })

  test('session.start registers tools and native agents', async ($, on) => {
    const { seen } = world(on)
    await start($)
    expect(seen.tools).toEqual(['delegate', 'delegate_result', 'delegate_cancel'])
    expect(seen.agents).toEqual(['oracle', 'designer', 'councillor-beta'])
    const oracle = seen.registered.find(spec => spec.name === 'oracle')
    expect(oracle?.tools).toBeUndefined()
    expect(oracle?.disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit', 'Agent', 'mcp__pantheon__delegate', 'mcp__pantheon__delegate_cancel'])
    expect(seen.registered.find(spec => spec.name === 'designer')?.disallowedTools).toBeUndefined()
  })

  test('delegate runs codex through process.spawn hook and returns final message', async ($, on) => {
    const { seen } = world(on)
    await start($)
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'explorer', prompt: 'find x' } as never))
    expect(out.status).toBe('done')
    expect(typeof out.result).toBe('string')
    expect(seen.argv[0]?.slice(0, 5)).toEqual(['codex', 'exec', '--json', '-s', 'read-only'])
    expect(seen.cwds[0]).toBe(ROOT)
  })

  test('absent user config registers default Claude roles and refuses Codex delegation', async ($, on) => {
    const { seen, files } = world(on)
    on('agent.offer', async () => ({ isOffered: true }))
    delete files[`${HOME}/.claude/pantheon.json`]
    await start($)
    expect(seen.agents).toEqual(['explorer', 'librarian', 'executor', 'oracle', 'designer', 'git', 'councillor-alpha', 'councillor-beta'])
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'explorer', prompt: 'find x' } as never))
    expect(out.error).toBe('Use pantheon:explorer through the Agent tool.')
    expect(seen.argv).toEqual([])
    expect((await $.agent.offer({ agent: 'pantheon:explorer', description: '', source: 'plugin', provider: { plugin: 'pantheon', tier: 'user' } } as never)).isOffered).toBe(true)
  })

  test('codex profile delegates oracle without registering it natively', async ($, on) => {
    const { seen } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{"profile":"codex"}' } })
    await start($)
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'oracle', prompt: 'review x' } as never))
    expect(out.status).toBe('done')
    expect(seen.argv.length).toBe(1)
    expect(seen.argv[0].slice(0, 5)).toEqual(['codex', 'exec', '--json', '-s', 'read-only'])
    expect(seen.agents).not.toContain('oracle')
  })

  test('profile switches hide native explorer, delegate it on Codex and re-register it on Claude', async ($, on) => {
    const { seen, files } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{"profile":"claude"}' } })
    on('agent.offer', async () => ({ isOffered: true }))
    on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
    on('prompt.compose', async () => ({ sections: [] }))
    const offer = () => $.agent.offer({ agent: 'pantheon:explorer', description: '', source: 'plugin', provider: { plugin: 'pantheon', tier: 'user' } } as never)
    const turn = async (turnId: string) => {
      await $.turn.start({ text: 'Go', turnId })
      await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    }
    await start($)
    expect((await offer()).isOffered).toBe(true)
    expect(seen.agents.filter(agent => agent === 'explorer').length).toBe(1)
    files[`${HOME}/.claude/pantheon.json`] = '{"profile":"codex"}'
    await turn('codex-turn')
    expect((await offer()).isOffered).toBe(false)
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'explorer', prompt: 'find x' } as never))
    expect(out.status).toBe('done')
    expect(seen.argv.length).toBe(1)
    expect(seen.argv[0].slice(0, 5)).toEqual(['codex', 'exec', '--json', '-s', 'read-only'])
    files[`${HOME}/.claude/pantheon.json`] = '{"profile":"claude"}'
    await turn('claude-turn')
    expect((await offer()).isOffered).toBe(true)
    expect(seen.agents.filter(agent => agent === 'explorer').length).toBe(2)
  })

  test('resume refuses a finished executor job after its engine changes to Claude', async ($, on) => {
    const { seen, files } = world(on)
    await start($)
    const first = parse(await $.tool.call({ tool: DELEGATE, agent: 'executor', prompt: 'x' } as never))
    expect(first.status).toBe('done')
    files[`${HOME}/.claude/pantheon.json`] = '{"profile":"claude"}'
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'executor', resume: first.jobId, prompt: 'x' } as never))
    expect(out.error).toBe('Use pantheon:executor through the Agent tool.')
    expect(seen.argv.length).toBe(1)
  })

  test('tool descriptions are generic across profiles', async ($, on) => {
    // Replace the fixture's terminal tool.register handler so the registration payload is observable.
    world(new Proxy(on, {
      apply(target, thisArg, args) {
        if (args[0] !== 'tool.register') return Reflect.apply(target, thisArg, args)
      },
    }))
    const descriptions: Record<string, string> = {}
    let agentDescription: unknown
    on('tool.register', async (_$, e) => {
      descriptions[e.name] = e.description
      if (e.name === 'delegate') agentDescription = (e.inputSchema as { properties: { agent: { description: string } } }).properties.agent.description
      return { value: { tool: `mcp__pantheon__${e.name}` } }
    })
    await start($)
    expect(descriptions.delegate).not.toContain('explorer, librarian, executor')
    expect(descriptions.delegate).toContain('Run a Pantheon role or council seat on Codex on a task')
    for (const text of Object.values(descriptions)) expect(text).not.toContain('currently on Codex')
    expect(agentDescription).toBe('A role or councillor:<seat> currently on Codex.')
  })

  describe('delegate tools deferral', () => {
    const NAMES = ['mcp__pantheon__delegate', 'mcp__pantheon__delegate_result', 'mcp__pantheon__delegate_cancel']
    function observe(on: On, profile: string, files: Record<string, string> = {}) {
      const w = world(new Proxy(on, {
        apply(target, thisArg, args) {
          if (args[0] !== 'tool.register') return Reflect.apply(target, thisArg, args)
        },
      }), { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ profile }), ...files } })
      const deferred: Record<string, boolean | undefined> = {}
      on('tool.describe', async (_$, e) => ({ description: e.description }))
      on('tool.register', async (_$, e) => {
        deferred[e.name] = e.isDeferred
        return { value: { tool: `mcp__pantheon__${e.name}` } }
      })
      return { ...w, deferred }
    }
    const describeAll = async ($: Engine) => Promise.all(NAMES.map(async tool => ($.tool.describe({ tool, description: 'd' } as never))))

    test('claude profile defers the tools at registration and in tool.describe', async ($, on) => {
      const { deferred } = observe(on, 'claude')
      await start($)
      expect(deferred).toEqual({ delegate: true, delegate_result: true, delegate_cancel: true })
      for (const out of await describeAll($)) expect(out.isDeferred).toBe(true)
    })

    test('a profile with Codex roles lists the tools and delegate works', async ($, on) => {
      const { deferred } = observe(on, 'codex')
      await start($)
      expect(deferred).toEqual({ delegate: false, delegate_result: false, delegate_cancel: false })
      for (const out of await describeAll($)) expect(out.isDeferred).toBe(false)
    })

    test('switching profile mid-session flips the deferral and invalidates tool.describe', async ($, on) => {
      const { files } = observe(on, 'claude')
      on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
      on('prompt.compose', async () => ({ sections: [] }))
      const invalidated: string[] = []
      on('ui.invalidate', async (_$, e) => { invalidated.push(e.event); return { value: undefined } })
      const compose = async (turnId: string) => {
        await $.turn.start({ text: 'Go', turnId })
        await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
      }
      await start($)
      files[`${HOME}/.claude/pantheon.json`] = '{"profile":"codex"}'
      await compose('t1')
      for (const out of await describeAll($)) expect(out.isDeferred).toBe(false)
      files[`${HOME}/.claude/pantheon.json`] = '{"profile":"claude"}'
      await compose('t2')
      for (const out of await describeAll($)) expect(out.isDeferred).toBe(true)
      expect(invalidated.filter(event => event === 'tool.describe').length).toBe(2)
    })
  })

  test('doctor under Claude without Codex reports it is not needed', async ($, on) => {
    world(on, {
      files: { [`${HOME}/.claude/pantheon.json`]: '{"profile":"claude"}' },
      runs: { 'codex --version': { exitCode: 127, stderr: 'codex: command not found' } },
    })
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(out.text).toContain('not needed by profile claude')
    expect(out.text).not.toContain('fail')
  })

  const PING_ORDER = ['explorer', 'librarian', 'executor', 'oracle', 'designer', 'git', 'councillor:alpha', 'councillor:beta']
  const agentMessage = (text: string) => `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })}\n`

  /** world() with its process.run replaced: Codex ping runs (`codex exec`) answer through `exec`; the rest is canned. */
  function pingWorld(on: On, opts: { profile: string; codex?: boolean; file?: string; exec?: (argv: string[], asked: string) => { exitCode: number; stdout?: string; stderr?: string } | Error | 'hang' }) {
    const execs: string[][] = []
    const inits: unknown[] = []
    const submits: string[] = []
    const fixture = world(new Proxy(on, {
      apply(target, thisArg, args) {
        if (args[0] !== 'process.run') return Reflect.apply(target, thisArg, args)
      },
    }), { files: { [`${HOME}/.claude/pantheon.json`]: opts.file ?? `{"profile":"${opts.profile}"}` } })
    const result = (r: { exitCode: number; stdout?: string; stderr?: string }) => ({
      value: { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    on('process.run', async (_$, e) => {
      const key = e.argv.join(' ')
      if (key === 'codex --version') return result(opts.codex === false ? { exitCode: 127, stderr: 'not found' } : { exitCode: 0, stdout: 'codex-cli 1.0\n' })
      if (key === 'codex login status') return result({ exitCode: 0, stdout: 'Logged in\n' })
      if (e.argv[0] === 'codex' && e.argv[1] === 'exec') {
        execs.push(e.argv)
        inits.push((e as { init?: unknown }).init)
        // The mock sees no stdin, so a ping's target is told by call order, which follows pingTargets order.
        const asked = PING_ORDER[execs.length - 1] ?? 'unknown'
        const out = opts.exec ? opts.exec(e.argv, asked) : { exitCode: 0, stdout: agentMessage(PING_ORDER.map(n => `pong ${n}`).join(' ')) }
        if (out === 'hang') return new Promise<never>(() => {})
        if (out instanceof Error) throw out
        return result(out)
      }
      return result({ exitCode: 0, stdout: `${ROOT}\n` })
    })
    on('prompt.submit', async (_$, e) => { submits.push(e.text); return { text: e.text } })
    return { ...fixture, execs, inits, submits }
  }

  test('doctor pings Codex targets, leaves native ones pending and submits one prompt', async ($, on) => {
    const { execs, submits, clock } = pingWorld(on, { profile: 'mixed' })
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(execs.length).toBeGreaterThan(0)
    expect(out.text).toContain('\nping\n')
    expect(out.text).toMatch(/^ok {3}\S+ \(codex/m)
    expect(out.text).toMatch(/^pending \S+ \(claude/m)
    expect(out.text).not.toMatch(/^fail \S+ \(codex/m)
    await clock.settle()
    expect(submits.length).toBe(1)
    expect(submits[0]).toContain('pantheon:')
  })

  test('doctor under Claude without Codex pings nothing and submits once', async ($, on) => {
    const { execs, submits, clock } = pingWorld(on, { profile: 'claude', codex: false })
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(execs).toEqual([])
    expect(out.text).toMatch(/^pending /m)
    expect(out.text).not.toMatch(/^ok {3}\S+ \(/m)
    await clock.settle()
    expect(submits.length).toBe(1)
  })

  test('a failing Codex ping becomes a fail line with the first stderr line', async ($, on) => {
    const { execs } = pingWorld(on, { profile: 'codex', exec: () => ({ exitCode: 3, stderr: 'bad auth\nmore' }) })
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(execs.length).toBeGreaterThan(0)
    expect(out.text).toMatch(/^fail explorer \(codex .*\): exit 3: bad auth$/m)
    expect(out.text).not.toContain('more')
  })

  test('a Codex ping sends its prompt on stdin and lets the host kill it at the timeout', async ($, on) => {
    const { inits } = pingWorld(on, { profile: 'mixed' })
    await start($)
    await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(inits.length).toBeGreaterThan(0)
    for (const init of inits as { stdin?: string; timeoutMs?: number }[]) {
      expect(init.stdin).toContain('pong ')
      expect(init.timeoutMs).toBe(60_000)
    }
  })

  test('every Codex ping runs read-only, even for roles that default to workspace-write', async ($, on) => {
    const { execs } = pingWorld(on, { profile: 'codex' })
    await start($)
    await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(execs.length).toBeGreaterThan(5)
    for (const argv of execs) expect(argv.slice(argv.indexOf('-s'), argv.indexOf('-s') + 2)).toEqual(['-s', 'read-only'])
  })

  test('git doctor ping has no writable roots or explicit network access', async ($, on) => {
    const { execs } = pingWorld(on, { profile: 'codex' })
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(out.text).toMatch(/^ok {3}git \(codex/m)
    expect(execs.length).toBe(PING_ORDER.length)
    const argv = execs[PING_ORDER.indexOf('git')]!
    expect(argv).toContain('sandbox_workspace_write.writable_roots=[]')
    expect(argv).not.toContain('sandbox_workspace_write.network_access=true')
    expect(argv.slice(argv.indexOf('-s'), argv.indexOf('-s') + 2)).toEqual(['-s', 'read-only'])
  })

  for (const [setting, value] of [['sandboxCap', 'read-only'], ['noNetwork', true]] as const) {
    test(`git doctor ping reports ${setting} restrictions`, async ($, on) => {
      pingWorld(on, { profile: 'codex', file: JSON.stringify({ profile: 'codex', [setting]: value }) })
      await start($)
      const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
      expect(out.text).toMatch(new RegExp(`^fail git \\(codex.*${setting}`, 'm'))
    })
  }

  test('a Codex ping that never answers becomes fail timeout', async ($, on) => {
    const { clock } = pingWorld(on, { profile: 'codex', exec: () => 'hang' })
    await start($)
    const run = $.command.run({ command: 'pantheon', args: 'doctor' })
    await clock.settle()
    await clock.advance(60_000)
    const out = await run
    expect(out.text).toMatch(/^fail explorer \(codex .*\): timeout$/m)
  })

  test('a ping needs exit 0 and the pong inside an agent message', async ($, on) => {
    pingWorld(on, { profile: 'codex', exec: (_argv, asked) => {
      if (asked === 'explorer') return { exitCode: 1, stdout: agentMessage('pong explorer') }
      if (asked === 'librarian') return { exitCode: 0, stdout: `${JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: `say pong ${asked}` } })}\n` }
      return { exitCode: 0, stdout: agentMessage(`pong ${asked}`) }
    } })
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(out.text).toMatch(/^fail explorer /m)
    expect(out.text).toMatch(/^fail librarian /m)
    expect(out.text).toMatch(/^ok {3}executor /m)
  })

  test('a throwing Codex ping does not throw out of doctor', async ($, on) => {
    pingWorld(on, { profile: 'codex', exec: () => new Error('boom') })
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(out.text).toMatch(/^fail explorer \(codex /m)
  })

  test('doctor skips the ping section and the submit when the config is invalid', async ($, on) => {
    const { execs, submits, clock } = pingWorld(on, { profile: 'mixed', file: '{ nope' })
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(out.text).not.toContain('ping')
    await clock.settle()
    expect(execs).toEqual([])
    expect(submits).toEqual([])
  })

  test('doctor does not submit when no target is native', async ($, on) => {
    const { submits, clock } = pingWorld(on, { profile: 'codex' })
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    await clock.settle()
    expect(out.text).not.toMatch(/^pending /m)
    expect(submits).toEqual([])
  })

  test('delegate refuses while config is invalid', async ($, on) => {
    const { seen } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{ nope' } })
    await start($)
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'explorer', prompt: 'x' } as never))
    expect(String(out.error)).toContain('Invalid Pantheon config')
    expect(seen.argv).toEqual([])
    expect(seen.toasts.length).toBe(1)
  })

  test('skipGitRepoCheck is true only when git rev-parse fails', async ($, on) => {
    const { seen } = world(on, { isRepo: false })
    await start($)
    await $.tool.call({ tool: DELEGATE, agent: 'explorer', prompt: 'x' } as never)
    expect(seen.argv[0]).toContain('--skip-git-repo-check')
  })

  test('skipGitRepoCheck is absent inside a repository', async ($, on) => {
    const { seen } = world(on)
    await start($)
    await $.tool.call({ tool: DELEGATE, agent: 'explorer', prompt: 'x' } as never)
    expect(seen.argv[0]).not.toContain('--skip-git-repo-check')
  })

  test('cwd resolving outside the root is refused', async ($, on) => {
    const { seen } = world(on, { realPaths: { '/repo/link': '/etc' } })
    await start($)
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'executor', prompt: 'x', cwd: '/repo/link' } as never))
    expect(String(out.error)).toContain('outside')
    expect(seen.argv).toEqual([])
  })

  test('resume: unknown job and job without sessionId -> error', async ($, on) => {
    world(on, { stdout: '' , exitCode: 1 })
    await start($)
    const unknown = parse(await $.tool.call({ tool: DELEGATE, agent: 'executor', prompt: 'x', resume: 'nope' } as never))
    expect(String(unknown.error)).toContain('Unknown job')
    const failed = parse(await $.tool.call({ tool: DELEGATE, agent: 'executor', prompt: 'x' } as never))
    expect(failed.status).toBe('error')
    const again = parse(await $.tool.call({ tool: DELEGATE, agent: 'executor', prompt: 'y', resume: failed.jobId } as never))
    expect(String(again.error)).toContain('delegate it again')
  })

  test('resume ignores a new cwd and reuses the stored one', async ($, on) => {
    const { seen } = world(on)
    await start($)
    const first = parse(await $.tool.call({ tool: DELEGATE, agent: 'executor', prompt: 'x', cwd: '/repo/sub' } as never))
    const moved = parse(await $.tool.call({ tool: DELEGATE, agent: 'executor', prompt: 'y', resume: first.jobId, cwd: '/repo/other' } as never))
    expect(String(moved.error)).toContain('recorded cwd')
    const ok = parse(await $.tool.call({ tool: DELEGATE, agent: 'executor', prompt: 'y', resume: first.jobId } as never))
    expect(ok.status).toBe('done')
    expect(seen.cwds).toEqual(['/repo/sub', '/repo/sub'])
    expect(seen.argv[1]).toContain('resume')
  })

  test('resume recomputes sandbox with a stricter current policy', async ($, on) => {
    const { seen, files } = world(on)
    await start($)
    const first = parse(await $.tool.call({ tool: DELEGATE, agent: 'executor', prompt: 'x' } as never))
    expect(seen.argv[0]).toContain('workspace-write')
    files[`${ROOT}/.claude/pantheon.json`] = JSON.stringify({ sandboxCap: 'read-only' })
    await $.tool.call({ tool: DELEGATE, agent: 'executor', prompt: 'y', resume: first.jobId } as never)
    expect(seen.argv[1]?.[4]).toBe('read-only')
  })

  test('resume revalidates the stored cwd before spawning', async ($, on) => {
    const realPaths: Record<string, string> = {}
    const { seen } = world(on, { realPaths })
    await start($)
    const first = parse(await $.tool.call({ tool: DELEGATE, agent: 'executor', prompt: 'x', cwd: '/repo/sub' } as never))
    realPaths['/repo/sub'] = '/elsewhere'
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'executor', prompt: 'y', resume: first.jobId } as never))
    expect(String(out.error)).toContain('outside')
    expect(seen.argv.length).toBe(1)
  })

  test('delegate_result reads a finished job', async ($, on) => {
    world(on)
    await start($)
    const first = parse(await $.tool.call({ tool: DELEGATE, agent: 'explorer', prompt: 'x' } as never))
    const read = parse(await $.tool.call({ tool: RESULT, jobId: first.jobId } as never))
    expect(read.status).toBe('done')
    expect(read.result).toBe(first.result)
  })

  test('session.start marks leftover running/background jobs as lost', async ($, on) => {
    world(on)
    const saved: Job[] = [
      { id: 'a', agent: 'executor', status: 'running', startedAt: 0, cwd: ROOT, sessionId: 's1' },
      { id: 'b', agent: 'explorer', status: 'background', startedAt: 0, cwd: ROOT },
      { id: 'c', agent: 'explorer', status: 'done', startedAt: 0, cwd: ROOT },
    ]
    let served = false
    on('state.get', async (_$, e, next) => {
      if (served || e.key !== 'jobs') return next(e)
      served = true
      return { value: { value: saved, version: 1 } }
    })
    await start($)
    const read = parse(await $.tool.call({ tool: RESULT, jobId: 'a' } as never))
    expect(read.status).toBe('lost')
    expect(read.isResumable).toBe(true)
    expect(parse(await $.tool.call({ tool: RESULT, jobId: 'b' } as never)).status).toBe('lost')
    expect(parse(await $.tool.call({ tool: RESULT, jobId: 'c' } as never)).status).toBe('done')
  })

  test('prompt.compose appends the orchestrator section last', async ($, on) => {
    world(on)
    on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' as const }] }))
    await start($)
    const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    const last = out.sections[out.sections.length - 1]
    expect(last?.id).toBe('pantheon:orchestrator')
    expect(last?.scope).toBe('session')
    expect(last?.text).toContain('delegate')
  })

  test('valid config change re-registers native agents; invalid change does not', async ($, on) => {
    const { seen, files } = world(on)
    on('prompt.compose', async () => ({ sections: [] }))
    await start($)
    expect(seen.agents.length).toBe(3)
    files[`${HOME}/.claude/pantheon.json`] = JSON.stringify({ profile: 'mixed', profiles: { mixed: { agents: { oracle: { model: 'sonnet' } } } } })
    await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    expect(seen.agents.length).toBe(6)
    files[`${HOME}/.claude/pantheon.json`] = '{ broken'
    await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    expect(seen.agents.length).toBe(6)
  })

  test('prompt.submit injects council block only for composer/bridge with trigger', async ($, on) => {
    world(on)
    const contexts: (readonly string[] | undefined)[] = []
    on('prompt.submit', async (_$, e) => { contexts.push(e.context); return { text: e.text, context: e.context } })
    await start($)
    await $.prompt.submit({ text: 'run a council on this', origin: { kind: 'composer' } } as never)
    await $.prompt.submit({ text: 'run a council on this', origin: { kind: 'sdk' } } as never)
    await $.prompt.submit({ text: 'fix the bug', origin: { kind: 'composer' } } as never)
    expect(String(contexts[0]?.join('\n'))).toContain('Council Mode')
    expect(contexts[1] ?? []).toEqual([])
    expect(contexts[2] ?? []).toEqual([])
  })

  test('agent.offer hides disabled pantheon agents', async ($, on) => {
    world(on, { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ disabledAgents: ['oracle'] }) } })
    on('agent.offer', async () => ({ isOffered: true }))
    await start($)
    const offer = (agent: string) => $.agent.offer({ agent, description: '', source: 'plugin', provider: { plugin: 'pantheon', tier: 'user' } } as never)
    expect((await offer('pantheon:oracle')).isOffered).toBe(false)
    expect((await offer('pantheon:designer')).isOffered).toBe(true)
    expect((await offer('Explore')).isOffered).toBe(true)
  })

  test('background delegate returns at once and wakes the session when done', async ($, on) => {
    const { clock } = world(on)
    const texts: string[] = []
    on('prompt.submit', async (_$, e) => { texts.push(e.text); return { text: e.text } })
    await start($)
    const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'explorer', prompt: 'x', background: true } as never))
    expect(out.status).toBe('background')
    await clock.settle()
    const done = parse(await $.tool.call({ tool: RESULT, jobId: out.jobId } as never))
    expect(done.status).toBe('done')
    expect(texts.some(text => text.includes(String(out.jobId)) && text.includes('delegate_result'))).toBe(true)
  })

  test('invalid first config still registers the default native agents', async ($, on) => {
    const { seen } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{ nope' } })
    await start($)
    expect(seen.agents).toEqual(['explorer', 'librarian', 'executor', 'oracle', 'designer', 'git', 'councillor-alpha', 'councillor-beta'])
  })

  test('a failed native registration is retried on the next turn', async ($, on) => {
    const { seen } = world(on, { failFirstRegister: true })
    on('prompt.compose', async () => ({ sections: [] }))
    await start($)
    expect(seen.tools).toEqual(['delegate', 'delegate_result', 'delegate_cancel'])
    await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    expect(seen.agents).toEqual(['oracle', 'designer', 'councillor-beta'])
  })

  describe('above-prompt strip', () => {
    const mountStrip = ($: Engine, columns = 120) => $.ui.mount({
      plugin: 'pantheon', surface: 'terminal', component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: columns } as never,
      viewport: { columns, rows: 40 } as never,
    })
    const texts = async (ui: Awaited<ReturnType<typeof mountStrip>>) =>
      (await ui.findAll({ type: 'Text' })).map(node => String(node.text)).join('|')
    function stripWorld(on: On, opts: Parameters<typeof world>[1] = {}, cost?: { usd: number }) {
      const fixture = world(on, opts)
      mock.store(on)
      on('ui.render', { component: 'AbovePrompt' }, async (_$, e) => _$.ui.resolve(e).Text({ children: 'below-marker' }) as never)
      on('session.id', async () => ({ value: 'session-1' }))
      on('session.model', async () => ({ value: 'claude-opus-5' }))
      on('session.usage', async () => ({
        value: {
          startedAt: 0, context: { tokens: 120_000, window: 1_000_000, percent: 12 },
          rateLimits: [{ kind: 'five_hour', percentUsed: 32, resetsAt: new Date(3 * 3_600_000).toISOString() }],
          ...(cost ? { cost: { usd: cost.usd } } : {}),
        },
      }))
      return fixture
    }

    test('renders the info, usage and limits rows with abovePrompt on', async ($, on) => {
      stripWorld(on)
      await start($)
      const ui = await mountStrip($)
      try {
        const all = await texts(ui)
        expect(all).toContain('Opus 5')
        expect(all).toContain('12%')
        expect(all).toContain('5h')
        // The box: borders and the quota bar with its clock mark.
        expect(all).toContain('╭')
        expect(all).toMatch(/━|╌|─/)
      } finally { await ui.unmount() }
    })

    test('mounts on the desktop surface through the engine (a refused tree would draw the engine\'s own) with the three HUD C rows', async ($, on) => {
      stripWorld(on, {}, { usd: 4.59 })
      await start($)
      const ui = await $.ui.mount({
        plugin: 'pantheon', surface: 'desktop', component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 100 } as never,
        viewport: { columns: 100, rows: 40 } as never,
      })
      try {
        const all = await texts(ui)
        expect(all).toContain('Opus 5')
        expect(all).toContain('5h')
        expect(all).toContain('$4.59')
        expect(all).toContain('below-marker')
        expect(all).not.toMatch(/╭/)
        expect(await ui.find({ key: 'strip' })).toBeDefined()
        expect(await ui.find({ key: 'strip-r1' })).toBeDefined()
        const pictures = (await ui.findAll({ type: 'Svg' })).map(n => (n as unknown as { props: { alt: string; isInteractive?: boolean } }).props)
        expect(pictures.some(p => p.alt === 'working' && p.isInteractive === undefined)).toBe(true)
        expect(pictures.some(p => p.alt.startsWith('5h'))).toBe(true)
      } finally { await ui.unmount() }
    })

    test('draws nothing of its own and returns what is below with abovePrompt off', { options: { abovePrompt: false } }, async ($, on) => {
      stripWorld(on)
      await start($)
      const ui = await mountStrip($)
      try {
        expect(await texts(ui)).toBe('below-marker')
      } finally { await ui.unmount() }
    })

    test('yields to a survey', async ($, on) => {
      stripWorld(on)
      await start($)
      const ui = await $.ui.mount({
        plugin: 'pantheon', surface: 'terminal', component: 'AbovePrompt',
        props: { hasSurvey: true, isWorking: false, maxRows: 12, bodyColumns: 120 } as never,
        viewport: { columns: 120, rows: 40 } as never,
      })
      try {
        expect(await texts(ui)).not.toContain('5h')
      } finally { await ui.unmount() }
    })

    test('folds a running background job into the box and drops it when idle', async ($, on) => {
      const { clock } = stripWorld(on, { hang: true })
      await start($)
      const idle = await mountStrip($)
      try { expect(await texts(idle)).not.toContain('executor') } finally { await idle.unmount() }
      const out = parse(await $.tool.call({ tool: DELEGATE, agent: 'executor', prompt: 'x', description: 'Wire the strip', background: true } as never))
      expect(out.status).toBe('background')
      await clock.settle()
      const ui = await mountStrip($)
      try {
        const all = await texts(ui)
        expect(all).toContain('agents ')
        expect(all).toContain('executor')
        expect(all).toContain('Wire the strip')
        // One row of the box, never cards above it.
        expect(all).not.toContain('╭─ ')
      } finally { await ui.unmount() }
    })

    test('every running non-role native counts in the folded row, labeled with its subagent type', async ($, on) => {
      stripWorld(on)
      let n = 0
      on('agent.spawn', async () => ({ model: 'model-1', agentId: `native-${++n}` }))
      await start($)
      const spawn = (tool_use_id: string, description: string, subagentType: string) =>
        $.agent.spawn({ ...spawnInput, tool_use_id, description, subagentType } as never)
      await spawn('t1', 'Map the auth code', 'Explore')
      await spawn('t2', 'Find the cache TTL', 'Explore')
      await spawn('t3', 'Review it', 'general-purpose')
      await spawn('t4', 'Fourth one', 'pantheon:executor')
      const ui = await mountStrip($, 140)
      try {
        const all = await texts(ui)
        expect(all.match(/Explore/g)?.length).toBe(2)
        expect(all).toContain('general-purpose')
        expect(all).toContain('+1')
        expect(all).toContain('Map the auth')
      } finally { await ui.unmount() }
    })

    describe('last-turn receipt', () => {
      function receiptWorld(on: On, cost = { usd: 10 }, spawned: object = { model: 'model-1', agentId: 'native-1' }) {
        const fixture = stripWorld(on, {}, cost)
        on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
        on('turn.complete', async () => ({ text: 'Completed' }))
        on('agent.spawn', async () => spawned as never)
        on('tool.call', async (_$, e) => (e.tool === 'Bash' ? { result: 'boom', isError: true } : e.tool === 'Blocked' ? { deny: 'no' } : { result: `ran ${e.tool}` }) as never)
        return fixture
      }
      const call = ($: Engine, tool: string, extra: object = {}) => $.tool.call({ tool, ...extra } as never) as Promise<Record<string, unknown>>

      test('counts the main loop\'s edits, errors and spawned agents per turn, and shows the receipt with the cost of the turn', async ($, on) => {
        const cost = { usd: 10 }
        receiptWorld(on, cost)
        await start($)
        await $.turn.start({ turnId: 'turn-1', text: 'go' } as never)
        await call($, 'Edit')
        await call($, 'Write')
        await call($, 'Read')
        await call($, 'Bash')
        await $.agent.spawn(spawnInput)
        cost.usd = 10.5
        // The spawned agent finishes (it would fold into the last row while it runs).
        await $.turn.complete({ ...completeInput, agentId: 'native-1' } as never)
        await $.turn.complete({ ...completeInput, durationMs: 157_000 } as never)
        const ui = await mountStrip($)
        try {
          const all = (await ui.findAll({ type: 'Text' })).map(node => String(node.text)).join('')
          expect(all).toContain('last turn 2m37s · 1 agent · 2 edits · 1 error · +$0.50')
        } finally { await ui.unmount() }
        // The next turn starts the counters over.
        await $.turn.start({ turnId: 'turn-2', text: 'again' } as never)
        await call($, 'Edit')
        await $.turn.complete({ ...completeInput, turnId: 'turn-2', durationMs: 5000 } as never)
        const again = await mountStrip($)
        try {
          const all = (await again.findAll({ type: 'Text' })).map(node => String(node.text)).join('')
          expect(all).toContain('last turn 5s · 0 agents · 1 edit · 0 errors')
        } finally { await again.unmount() }
      })

      test('a subagent\'s tool calls and spawns never count, and an error turn end adds one error', async ($, on) => {
        receiptWorld(on)
        await start($)
        await $.turn.start({ turnId: 'turn-1', text: 'go' } as never)
        await call($, 'Edit', { agentId: 'native-9' })
        await call($, 'Bash', { agentId: 'native-9' })
        await $.agent.spawn({ ...spawnInput, parentAgentId: 'native-9' })
        await $.turn.complete({ ...completeInput, agentId: 'native-1' } as never)
        await $.turn.complete({ ...completeInput, reason: 'error', durationMs: 1000 } as never)
        const ui = await mountStrip($)
        try {
          const all = (await ui.findAll({ type: 'Text' })).map(node => String(node.text)).join('')
          expect(all).toContain('last turn 1s · 0 agents · 0 edits · 1 error')
        } finally { await ui.unmount() }
      })

      test('every handler answers as the engine did: results, denials and events pass through unchanged', async ($, on) => {
        receiptWorld(on)
        await start($)
        expect(await $.turn.start({ turnId: 'turn-1', text: 'go' } as never)).toEqual({ turnId: 'turn-1' })
        expect(await call($, 'Edit')).toMatchObject({ result: 'ran Edit' })
        expect(await call($, 'Bash')).toMatchObject({ result: 'boom', isError: true })
        expect(await call($, 'Blocked')).toMatchObject({ deny: 'no' })
        expect(await $.agent.spawn(spawnInput)).toMatchObject({ model: 'model-1', agentId: 'native-1' })
        expect(await $.turn.complete(completeInput as never)).toEqual({ text: 'Completed' })
      })

      test('a spawn the engine did not start (no agent id) is not counted', async ($, on) => {
        receiptWorld(on, { usd: 10 }, { model: 'model-1' })
        await start($)
        await $.turn.start({ turnId: 'turn-1', text: 'go' } as never)
        await $.agent.spawn(spawnInput)
        await $.turn.complete({ ...completeInput, durationMs: 1000 } as never)
        const ui = await mountStrip($)
        try {
          const all = (await ui.findAll({ type: 'Text' })).map(node => String(node.text)).join('')
          expect(all).toContain('last turn 1s · 0 agents')
        } finally { await ui.unmount() }
      })

      test('with abovePrompt off nothing is counted', { options: { abovePrompt: false } }, async ($, on) => {
        receiptWorld(on)
        await start($)
        await $.turn.start({ turnId: 'turn-1', text: 'go' } as never)
        await call($, 'Edit')
        await $.turn.complete(completeInput as never)
        const ui = await mountStrip($)
        try { expect(await texts(ui)).toBe('below-marker') } finally { await ui.unmount() }
      })
    })

    test('tracking hooks still pass events and results on unchanged', async ($, on) => {
      const fixture = trackingWorld(on)
      mock.store(on)
      await start($)
      const { chunks, result } = await step($, stepInput(0, undefined))
      expect(chunks).toEqual([])
      expect(result).toEqual({ ...stepResult, turnId: 'turn-1', index: 0 })
      expect(await $.turn.complete(completeInput as never)).toEqual({ text: 'Completed' })
      expect(await $.session.measure(measureInput as never)).toEqual({ changed: ['context'] })
      expect(fixture.forwarded).toEqual(['turn-1'])
    })
  })
})
