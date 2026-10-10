import { describe, expect, test, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpawnInput, FsStat, On, TurnStepInput } from 'claude-code'

import type { Native, SessionInfo } from '../types'
import { createQueue, resolveGatePath, withGateRecovery } from '../hooks/register'
import { gateContext } from '../hooks/gate'
import { PANE_ID } from '../hooks/pane'
import { HOME, ROOT, start, world } from './fixtures/world'

const spawnInput = {
  tool_use_id: 'spawn-1', prompt: 'Review the change', description: 'Review',
  subagentType: 'pantheon:architect', provider: { plugin: 'pantheon', tier: 'user' },
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
// Rules: gateEdit is tiny (allow), gateGrey is not trivial (ask) and gateBig is too large (deny).
const gateGrey = { ...gateEdit, tool_use_id: 'gate-grey', new_string: 'private\n'.repeat(10) }
const gateBig = { ...gateEdit, tool_use_id: 'gate-big', new_string: 'line\n'.repeat(110) }
const gatePause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function gateWorld(on: On, opts: { interrupt?: boolean; fault?: 'workspace' | 'env'; files?: Record<string, string>; cwd?: string; realPaths?: Record<string, string | undefined>; statErrors?: Record<string, string>; unresolvedLinks?: string[]; uid?: string | null } = {}) {
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
    return { value: e.name === 'HOME' ? HOME : undefined }
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
    // The gate decides by local rules and never fetches; every test asserts `sent` stays empty.
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
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
  test('resolver treats the engine\'s own ENOENT message (no code) as a missing path, and only that shape', async () => {
    const real = (path: string) => new Error(`pantheon: $.fs.stat(${path}) failed: ENOENT`)
    const stat = async (path: string): Promise<FsStat> => {
      if (path === '/repo/src/new.ts') throw real(path)
      return pathStat(path)
    }
    expect(await resolveGatePath(stat, '/repo/src/new.ts', ROOT)).toBe('/repo/src/new.ts')
    const other = async (path: string): Promise<FsStat> => {
      if (path === '/repo/src/new.ts') throw new Error('pantheon: $.fs.stat(/repo/src/new.ts) failed: EACCES')
      return pathStat(path)
    }
    await expect(resolveGatePath(other, '/repo/src/new.ts', ROOT)).rejects.toThrow('EACCES')
  })
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
    test(`path resolution holds on ${failure}`, { options: { gate: true, abovePrompt: false } }, async ($, on) => {
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
      '/repo/.pantheon/plans/new/deep/a.ts': undefined, '/repo/.pantheon/plans/new/deep': undefined, '/repo/.pantheon/plans/new': undefined,
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
    expect((await context('/repo/.pantheon/plans/new/deep/a.ts')).skip).toBe(true)
    for (const file_path of ['/repo/link/new/deep/a.ts', '../src/a.ts', '/repo/src/a.ts', '/repo/.pantheon/chain.ts']) {
      expect((await context(file_path)).skip).toBe(false)
    }
    expect(inspected).toContainEqual({ path: '/repo/.pantheon/plans/new/deep/a.ts', resolve: false })
  })
  test('only exact state and scratchpad exemptions bypass the gate and uid is cached', { options: { gate: true } }, async ($, on) => {
    const host = gateWorld(on)
    const exempt = ['/repo/.pantheon/a.md', `${HOME}/.claude/plans/a.md`, `${HOME}/.claude/projects/repo/memory/a.md`, '/tmp/claude-501/repo/session/scratchpad/a.ts', '/private/tmp/claude-501/repo/session/scratchpad/a.ts']
    for (const file_path of exempt) expect((await $.tool.call({ ...gateEdit, file_path } as never)).deny).toBeUndefined()
    expect(host.sent).toEqual([])
    const gated = ['settings.json', 'CLAUDE.md', 'hooks/a.ts', 'mods/a.ts', 'skills/a.ts', 'plugins/a.ts'].map(p => `${HOME}/.claude/${p}`)
    gated.push('/tmp/claude-502/repo/session/scratchpad/a.ts', '/tmp/claude-501/session/scratchpad/a.ts', '/tmp/claude-501/a.ts')
    for (const file_path of gated) expect((await $.tool.call({ ...gateBig, file_path } as never)).deny).toContain('Denied by rules')
    expect(host.sent).toEqual([])
    expect(host.uidReads()).toBe(1)
  })
  test('uid lookup failure is cached and grants no scratchpad exemption', { options: { gate: true } }, async ($, on) => {
    const host = gateWorld(on, { uid: null })
    for (let i = 0; i < 2; i++) expect((await $.tool.call({ ...gateBig, file_path: '/tmp/claude-501/repo/session/scratchpad/a.ts' } as never)).deny).toContain('Denied by rules')
    expect(host.uidReads()).toBe(1)
    expect(host.sent).toEqual([])
  })
  test('resolved symlink targets are gated', { options: { gate: true } }, async ($, on) => {
    const host = gateWorld(on, { realPaths: {
      '/repo/.pantheon/source.ts': '/repo/src/source.ts',
      [`${HOME}/.claude/plans/source.ts`]: '/repo/src/source.ts',
    } })
    for (const file_path of ['/repo/.pantheon/source.ts', `${HOME}/.claude/plans/source.ts`]) {
      expect((await $.tool.call({ ...gateBig, file_path } as never)).deny).toContain('Denied by rules')
    }
    expect(host.sent).toEqual([])
    expect(host.forwarded).toEqual([])
  })
  test('relative paths use session cwd rather than repository root', { options: { gate: true } }, async ($, on) => {
    const host = gateWorld(on, { cwd: '/repo/sub', realPaths: { '/repo/sub/../.pantheon/plans/note.md': '/repo/.pantheon/plans/note.md' } })
    expect((await $.tool.call({ ...gateBig, file_path: '.pantheon/plans/note.md' } as never)).deny).toContain('Denied by rules')
    expect((await $.tool.call({ ...gateBig, file_path: '../.pantheon/plans/note.md' } as never)).deny).toBeUndefined()
    expect(host.sent).toEqual([])
  })
  for (const fault of ['workspace', 'env'] as const) {
    test(`${fault} failure asks instead of running the edit`, { options: { gate: true, abovePrompt: false } }, async ($, on) => {
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
    test(`parallel holds keep the second notice after delayed cleanup (${reverse})`, { options: { gate: true, abovePrompt: false } }, async ($, on) => {
      const opts = { interrupt: false }
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
      const first = $.tool.call({ ...gateGrey, tool_use_id: reverse ? 'b' : 'a' } as never)
      await gatePause(30)
      const second = $.tool.call({ ...gateGrey, tool_use_id: reverse ? 'a' : 'b' } as never)
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
  test('allows a tiny edit by rules, reuses the root and never fetches', { options: { gate: true } }, async ($, on) => {
    const host = gateWorld(on)
    await start($)
    const probes = host.probes()
    for (let i = 0; i < 3; i++) expect(await $.tool.call(gateEdit as never)).toEqual({ result: 'unchanged' })
    expect(host.forwarded).toHaveLength(3)
    expect(host.probes()).toBe(probes)
    expect(host.sent).toEqual([])
  })
  test('denies a large change by rules and points to developer', { options: { gate: true } }, async ($, on) => {
    const host = gateWorld(on)
    expect((await $.tool.call(gateBig as never)).deny).toContain('delegate to developer')
    expect(host.forwarded).toEqual([])
    expect(host.sent).toEqual([])
  })
  test('skips subagents and exempt directories without requests', { options: { gate: true } }, async ($, on) => {
    const host = gateWorld(on)
    for (const event of [{ ...gateEdit, agentId: 'native-1' }, ...['/repo/.pantheon/plan.md', `${HOME}/.claude/plans/note.md`, '/private/tmp/claude-501/repo/session/scratchpad/a.ts', '/tmp/claude-501/repo/session/scratchpad/a.ts'].map(file_path => ({ ...gateEdit, file_path }))]) {
      expect((await $.tool.call(event as never)).deny).toBeUndefined()
    }
    expect(host.sent).toEqual([])
    expect(host.forwarded).toHaveLength(5)
  })
  test('local rules decide with no key, no option and no network', { options: { gate: true } }, async ($, on) => {
    const host = gateWorld(on)
    expect((await $.tool.call(gateEdit as never)).deny).toBeUndefined()
    expect((await $.tool.call(gateBig as never)).deny).toContain('Denied by rules')
    expect(host.sent).toEqual([])
    expect(host.forwarded).toHaveLength(1)
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`grey zone waits for Proceed or Cancel on ${surface}`, { options: { gate: true, abovePrompt: false } }, async ($, on) => {
      const host = gateWorld(on)
      await $.session.start({ cwd: ROOT, surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'pantheon', component: 'AbovePrompt', surface, props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} } })
      for (const decision of ['cancel', 'proceed']) {
        const pending = $.tool.call(gateGrey as never)
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
  test('a failed hold denies instead of letting the edit through', { options: { gate: true } }, async ($, on) => {
    const host = gateWorld(on, { interrupt: true })
    await start($)
    expect((await $.tool.call(gateGrey as never)).deny).toContain('interrupted')
    expect(host.forwarded).toEqual([])
  })
  test('disabled roles are not recommended', { options: { gate: true } }, async ($, on) => {
    gateWorld(on, { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ disabledAgents: ['developer', 'ux'] }) } })
    await start($)
    const result = await $.tool.call({ ...gateBig, file_path: '/repo/view.tsx' } as never)
    expect(result.deny).toContain('ask the person to handle implementation')
    expect(result.deny).not.toContain('delegate')
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
    expect((await $.tool.call(gateBig as never)).deny).toContain('Denied by rules')
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
  const mountPanel = ($: Engine) => $.ui.mount({
    plugin: 'pantheon', surface: 'terminal', component: 'Pane', requestId: PANE_ID,
    props: { title: 'Pantheon', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } },
    viewport: { columns: 120, rows: 40 },
  })

  test('panel reloads the config between renders without a prompt', async ($, on) => {
    const { files, seen } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{}' } })
    const first = await mountPanel($)
    await first.unmount()
    expect(seen.agents.length).toBe(8)
    files[`${ROOT}/.claude/pantheon.json`] = JSON.stringify({ disabledAgents: ['architect'] })
    const second = await mountPanel($)
    await second.unmount()
    // The new config registers its own agents once.
    expect(seen.agents.length).toBe(15)
  })

  test('panel keeps the last valid config and warns once across invalid JSON renders without invalidating itself', async ($, on) => {
    const { files, seen } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{"agents":{"architect":{"effort":"high"}}}' } })
    const invalidations: string[] = []
    on('ui.invalidate', async (_$, e) => { invalidations.push(e.event); return { value: undefined } })
    const first = await mountPanel($)
    await first.unmount()
    files[`${HOME}/.claude/pantheon.json`] = '{ broken'
    for (let i = 0; i < 2; i++) {
      const ui = await mountPanel($)
      await ui.unmount()
    }
    expect(seen.toasts).toEqual([`pantheon: invalid config — ${HOME}/.claude/pantheon.json: Invalid JSON`])
    expect(seen.agents.length).toBe(8)
    expect(invalidations).toEqual([])
  })


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

  test('agent.spawn of pantheon:architect records a native through steps, tools and completion', async ($, on) => {
    trackingWorld(on)
    await start($)
    await $.agent.spawn(spawnInput)
    await step($)
    await $.tool.call({ tool: 'Bash', command: 'pwd', agentId: 'native-1' })
    await $.turn.complete({ ...completeInput, agentId: 'native-1' })
    const [native] = await nativesOf($)
    expect(native.role).toBe('architect')
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
    const saved: Native[] = [{ id: 'old', role: 'architect', type: 'pantheon:architect', task: 'Old', model: 'm',
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

  test('session.start registers the native agents and the flow tool', async ($, on) => {
    const { seen } = world(on)
    await start($)
    expect(seen.tools).toEqual(['flow'])
    expect(seen.agents).toEqual(['code-reader', 'docs-reader', 'developer', 'architect', 'qa', 'ux', 'councillor-alpha', 'councillor-beta'])
    const architect = seen.registered.find(spec => spec.name === 'architect')
    expect(architect?.tools).toBeUndefined()
    expect(architect?.disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit', 'Agent'])
    expect(seen.registered.find(spec => spec.name === 'git')).toBeUndefined()
    expect(seen.registered.find(spec => spec.name === 'ux')?.disallowedTools).toBeUndefined()
  })

  test('absent user config registers the default roles and offers them', async ($, on) => {
    const { seen, files } = world(on)
    on('agent.offer', async () => ({ isOffered: true }))
    delete files[`${HOME}/.claude/pantheon.json`]
    await start($)
    expect(seen.agents).toEqual(['code-reader', 'docs-reader', 'developer', 'architect', 'qa', 'ux', 'councillor-alpha', 'councillor-beta'])
    expect((await $.agent.offer({ agent: 'pantheon:code-reader', description: '', source: 'plugin', provider: { plugin: 'pantheon', tier: 'user' } } as never)).isOffered).toBe(true)
  })

  test('configured models and prompts reach the registered agents', async ($, on) => {
    const { seen } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({
      agents: { architect: { model: 'sonnet', effort: 'high', prompt: 'extra' } },
      council: { seats: { beta: { model: 'haiku' } } },
    }) } })
    await start($)
    const architect = seen.registered.find(spec => spec.name === 'architect') as { model?: string; effort?: string; prompt?: string }
    expect(architect.model).toBe('sonnet')
    expect(architect.effort).toBe('high')
    expect(architect.prompt).toContain('extra')
    const beta = seen.registered.find(spec => spec.name === 'councillor-beta') as { model?: string } | undefined
    expect(beta?.model).toBe('haiku')
  })

  test('/pantheon config reports the merged config and where it came from', async ($, on) => {
    world(on, { files: {
      [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ agents: { architect: { effort: 'high' } } }),
      [`${ROOT}/.claude/pantheon.json`]: JSON.stringify({ disabledAgents: ['qa'] }),
    } })
    await start($)
    const report = (await $.command.run({ command: 'pantheon', args: 'config' })).text ?? ''
    expect(report).not.toMatch(/profile|codex|sandbox/i)
    expect(report).toContain('architect')
    expect(report).toContain('disabledAgents')
  })

  test('an unknown /pantheon subcommand lists the available ones', async ($, on) => {
    world(on)
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'cancel' })
    expect(out.text).toBe('Unknown subcommand: cancel. Use /pantheon, /pantheon close, /pantheon config, /pantheon doctor, /pantheon flow or /pantheon goal [text].')
  })

  const PING_ORDER = ['code-reader', 'docs-reader', 'developer', 'architect', 'qa', 'ux', 'councillor:alpha', 'councillor:beta']

  function doctorWorld(on: On, file?: string) {
    const submits: string[] = []
    const fixture = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: file ?? '{}' } })
    on('prompt.submit', async (_$, e) => { submits.push(e.text); return { text: e.text } })
    return { ...fixture, submits }
  }

  test('doctor lists every target as pending and submits one ping prompt', async ($, on) => {
    const { submits, clock } = doctorWorld(on)
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(out.text).toContain('\nping\n')
    for (const name of PING_ORDER) expect(out.text).toMatch(new RegExp(`^pending ${name} `, 'm'))
    expect(out.text).not.toMatch(/codex|fail/i)
    await clock.settle()
    expect(submits.length).toBe(1)
    expect(submits[0]).toContain('pantheon:code-reader')
    expect(submits[0]).toContain('pantheon:councillor-beta')
  })

  test('doctor marks disabled agents off and leaves them out of the ping prompt', async ($, on) => {
    const { submits, clock } = doctorWorld(on, JSON.stringify({ disabledAgents: ['ux', 'councillor:beta'] }))
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(out.text).toMatch(/^info ux off$/m)
    expect(out.text).toMatch(/^info councillor:beta off$/m)
    await clock.settle()
    expect(submits.length).toBe(1)
    expect(submits[0]).not.toContain('pantheon:ux')
    expect(submits[0]).not.toContain('councillor-beta')
    expect(submits[0]).toContain('pantheon:architect')
  })

  test('doctor skips the ping section and the submit when the config is invalid', async ($, on) => {
    const { submits, clock } = doctorWorld(on, '{ nope')
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    expect(out.text).not.toContain('ping')
    await clock.settle()
    expect(submits).toEqual([])
  })

  test('doctor does not submit when every target is disabled', async ($, on) => {
    const { submits, clock } = doctorWorld(on, JSON.stringify({ disabledAgents: ['code-reader', 'docs-reader', 'developer', 'architect', 'qa', 'ux', 'council'] }))
    await start($)
    const out = await $.command.run({ command: 'pantheon', args: 'doctor' })
    await clock.settle()
    expect(out.text).not.toMatch(/^pending /m)
    expect(submits).toEqual([])
  })

  test('removed config fields make the config invalid with a migration message', async ($, on) => {
    const { seen } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{"profile":"codex"}' } })
    await start($)
    expect(seen.toasts.length).toBe(1)
    expect(seen.toasts[0]).toContain('pantheon: invalid config')
    expect(seen.toasts[0]).toContain('profiles were removed')
    expect(seen.agents.length).toBe(8)
  })


  test('prompt.compose appends the lead section last', async ($, on) => {
    world(on)
    on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' as const }] }))
    await start($)
    const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    const last = out.sections[out.sections.length - 1]
    expect(last?.id).toBe('pantheon:lead')
    expect(last?.scope).toBe('session')
    expect(last?.text).toContain('pantheon:architect')
  })

  test('valid config change re-registers native agents; invalid change does not', async ($, on) => {
    const { seen, files } = world(on)
    on('prompt.compose', async () => ({ sections: [] }))
    await start($)
    expect(seen.agents.length).toBe(8)
    files[`${HOME}/.claude/pantheon.json`] = JSON.stringify({ agents: { architect: { model: 'sonnet' } } })
    await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    expect(seen.agents.length).toBe(16)
    expect(seen.registered.filter(spec => spec.name === 'architect').map(spec => (spec as { model?: string }).model)).toEqual(['opus', 'sonnet'])
    files[`${HOME}/.claude/pantheon.json`] = '{ broken'
    await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    expect(seen.agents.length).toBe(16)
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
    world(on, { files: { [`${HOME}/.claude/pantheon.json`]: JSON.stringify({ disabledAgents: ['architect'] }) } })
    on('agent.offer', async () => ({ isOffered: true }))
    await start($)
    const offer = (agent: string) => $.agent.offer({ agent, description: '', source: 'plugin', provider: { plugin: 'pantheon', tier: 'user' } } as never)
    expect((await offer('pantheon:architect')).isOffered).toBe(false)
    expect((await offer('pantheon:ux')).isOffered).toBe(true)
    expect((await offer('Explore')).isOffered).toBe(true)
  })

  test('invalid first config still registers the default native agents', async ($, on) => {
    const { seen } = world(on, { files: { [`${HOME}/.claude/pantheon.json`]: '{ nope' } })
    await start($)
    expect(seen.agents).toEqual(['code-reader', 'docs-reader', 'developer', 'architect', 'qa', 'ux', 'councillor-alpha', 'councillor-beta'])
  })

  test('a failed native registration is retried on the next turn', async ($, on) => {
    const { seen } = world(on, { failFirstRegister: true })
    on('prompt.compose', async () => ({ sections: [] }))
    await start($)
    expect(seen.agents).toEqual([])
    await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    expect(seen.agents).toEqual(['code-reader', 'docs-reader', 'developer', 'architect', 'qa', 'ux', 'councillor-alpha', 'councillor-beta'])
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

    test('folds a running native into the box and drops it when it ends', async ($, on) => {
      stripWorld(on)
      on('agent.spawn', async () => ({ model: 'model-1', agentId: 'native-1' }))
      on('turn.complete', async () => ({ text: 'Completed' }))
      await start($)
      const idle = await mountStrip($)
      try { expect(await texts(idle)).not.toContain('developer') } finally { await idle.unmount() }
      await $.agent.spawn({ ...spawnInput, description: 'Wire the strip', subagentType: 'pantheon:developer' } as never)
      const ui = await mountStrip($)
      try {
        const all = await texts(ui)
        expect(all).toContain('agents ')
        expect(all).toContain('developer')
        expect(all).toContain('Wire the strip')
        // One row of the box, never cards above it.
        expect(all).not.toContain('╭─ ')
      } finally { await ui.unmount() }
      await $.turn.complete({ ...completeInput, agentId: 'native-1' } as never)
      const done = await mountStrip($)
      try { expect(await texts(done)).not.toContain('Wire the strip') } finally { await done.unmount() }
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
      await spawn('t4', 'Fourth one', 'pantheon:developer')
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
