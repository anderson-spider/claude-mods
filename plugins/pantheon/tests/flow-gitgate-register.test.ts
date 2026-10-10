import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpawnInput, On } from 'claude-code'

import { sha256 } from '../hooks/flow/plan'
import { HOME, ROOT, start, world } from './fixtures/world'

// Provider-shaped fixtures are assembled at runtime so no source literal matches a secret scanner.
const join = (...parts: string[]) => parts.join('')

// The git gate wired into the host (decision 12): Bash git held to who runs it, over an in-memory repository.

const PLAN = '.pantheon/plans/demo.md'
const planMd = (flow: object) => `# Plan\n\n\`\`\`pantheon-flow\n${JSON.stringify(flow, null, 2)}\n\`\`\`\n`
const FLOW = {
  schemaVersion: 1, planId: 'demo', goal: 'Ship the thing',
  tasks: [
    { id: 'T1', goal: 'first', files: ['src/a.ts', 'src/c.ts'], acceptance: { checks: [{ argv: ['npm', 'test'] }] } },
    { id: 'T2', goal: 'second', files: ['src/b/**'], acceptance: { checks: [{ argv: ['npm', 'run', 'lint'] }] } },
  ],
}
const JOURNAL = `${ROOT}/.pantheon/flow/demo/journal.jsonl`

const spawnBase = {
  tool_use_id: 'spawn-1', prompt: 'Do the task', description: '[T1] first', subagentType: 'pantheon:developer',
  provider: { plugin: 'pantheon', tier: 'user' }, parentModel: 'parent', permissionMode: 'default', background: false, fork: false,
} as AgentSpawnInput

type Agent = { id: string; description: string; type: string; status: 'running'; parentId?: string }

function gitWorld(on: On, opts: { plan?: boolean; realPaths?: Record<string, string> } = {}) {
  const files = new Map<string, string>([[`${HOME}/.claude/pantheon.json`, '{}'], ...(opts.plan === false ? [] : [[`${ROOT}/${PLAN}`, planMd(FLOW)] as [string, string]])])
  // What the host was asked for, in order: a mode that must not read anything leaves this empty.
  const calls: string[] = []
  const branchLookups: string[][] = []
  const configLookups: string[][] = []
  // The directory each branch or settings lookup ran in: undefined is the session's.
  const lookupCwds: (string | undefined)[] = []
  const faults = { stat: false, list: false, journal: false }
  // The checked-out branch as `git rev-parse --abbrev-ref HEAD` answers it.
  const git = { branch: 'feature/x', exitCode: 0, throws: false, config: [] as string[], configExit: 1 }
  const skip = new Set(['fs.exists', 'fs.read', 'fs.stat', 'process.run'])
  // The host's own store: the flow controller keeps the record of an approval there.
  mock.store(on)
  const fixture = world(new Proxy(on, {
    apply(target, self, args) { if (skip.has(args[0])) return; return Reflect.apply(target, self, args) },
  }))
  const agents: Agent[] = []
  on('agent.list', async () => {
    calls.push('agent.list')
    if (faults.list) throw new Error('agent list unavailable')
    return { value: agents.map(agent => ({ ...agent })) }
  })
  on('fs.stat', async (_$, e) => {
    calls.push(`fs.stat ${e.path}`)
    if (faults.stat) throw new Error('stat unavailable')
    const realPath = opts.realPaths?.[e.path] ?? e.path
    return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: realPath !== e.path, realPath } }
  })
  on('session.id', async () => ({ value: 'sess-1' }))
  on('fs.exists', async (_$, e) => {
    calls.push(`fs.exists ${e.path}`)
    return { value: files.has(e.path) || [...files.keys()].some(path => path.startsWith(`${e.path}/`)) }
  })
  on('fs.read', async (_$, e) => {
    calls.push(`fs.read ${e.path}`)
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$, e) => {
    if (faults.journal && e.path.endsWith('/journal.jsonl')) throw new Error('read-only file system')
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', async (_$, e) => ({
    value: [...files.keys()].filter(path => path.startsWith(`${e.path}/`) && !path.slice(e.path.length + 1).includes('/'))
      .map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('process.run', async (_$, e) => {
    calls.push(`process.run ${e.argv.join(' ')}`)
    const argv = [...e.argv]
    const done = (stdout = '', exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'git') {
      if (argv.includes('--show-toplevel')) return done(`${ROOT}\n`)
      if (argv.includes('--get-regexp')) {
        lookupCwds.push(e.init?.cwd)
        configLookups.push(argv.slice(1, argv.indexOf('config')))
        // Exit 1 is "no such key"; with lines to show it is 0.
        const exitCode = git.config.length > 0 ? 0 : git.configExit
        return done(git.config.map(line => `${line}\n`).join(''), exitCode)
      }
      if (argv.includes('--abbrev-ref')) {
        lookupCwds.push(e.init?.cwd)
        branchLookups.push(argv.slice(1, argv.indexOf('rev-parse')))
        if (git.throws) throw new Error('spawn git ENOENT')
        return done(git.exitCode === 0 ? `${git.branch}\n` : '', git.exitCode, git.exitCode === 0 ? '' : 'fatal: not a git repository')
      }
      if (argv[1] === 'rev-parse') return done('aaaa1111\n')
      if (argv[1] === 'hash-object') return done(`${sha256(String(e.init?.stdin ?? '')).slice(0, 40)}\n`)
      return done('')
    }
    if (argv[0] === 'id') return done('501\n')
    return done('')
  })
  const engine = { spawnId: 'agent-1' }
  on('agent.spawn', async () => ({ model: 'model-1', agentId: engine.spawnId }))
  // The Bash call as the engine would run it: whatever reaches here was not denied.
  const ran: string[] = []
  on('tool.call', async (_$, e) => {
    if (e.tool === 'Bash' || e.tool === 'Monitor') ran.push(String((e as { command?: unknown }).command ?? '<ws>'))
    return { result: 'ran', text: 'ran' } as never
  })
  const journal = () => (files.get(JOURNAL) ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
  return { ...fixture, files, calls, branchLookups, configLookups, lookupCwds, faults, git, engine, agents, ran, journal }
}
type World = ReturnType<typeof gitWorld>

const bash = ($: Engine, command: string, agentId?: string) =>
  $.tool.call({ tool: 'Bash', command, description: 'run it', ...(agentId ? { agentId } : {}) } as never)

async function boot($: Engine, w: World) {
  await start($)
  const out = await $.command.run({ command: 'pantheon', args: `flow approve ${PLAN}` } as never)
  expect(out.text).toContain('Approved demo')
  expect(w.files.get(`${ROOT}/.pantheon/flow/active`)).toBe(`${PLAN}\n`)
}

/** A developer of task T1 whose spawn went through the flow, so its link holds the task's files. */
async function developer($: Engine, w: World, id = 'dev-1') {
  w.engine.spawnId = id
  expect(await $.agent.spawn({ ...spawnBase, description: '[T1] first' } as never)).toMatchObject({ agentId: id })
  return id
}

describe('the lead', () => {
  test('enforce: a push of a feature branch goes through', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    for (const command of ['git push origin feature/x', 'git push -u origin HEAD', 'git push', 'git status && git log --oneline -3', 'npm test']) {
      expect((await bash($, command)).deny, command).toBeUndefined()
    }
    expect(w.ran).toHaveLength(5)
    expect(w.journal().filter(entry => entry.event === 'git')).toEqual([])
  })

  test('enforce: a push that names main, master, develop, release or release/* is denied', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    for (const target of ['main', 'master', 'develop', 'release', 'release/1.2']) {
      const out = await bash($, `git push origin ${target}`)
      expect(out.deny, target).toContain(`[Pantheon flow] Pushing to the protected branch \`${target}\` is denied`)
    }
    expect((await bash($, 'git push origin HEAD:release/1.2')).deny).toContain('`release/1.2`')
    expect(w.ran).toEqual([])
    // Named pushes are decided by the text: git was not asked which branch is checked out.
    expect(w.branchLookups).toEqual([])
    expect(w.journal().at(-1)).toMatchObject({ event: 'git', condition: 'git_gate', action: 'block', mode: 'enforce', detail: 'lead: git push' })
  })

  test('enforce: a bare push, a push to a remote and HEAD go to the checked-out branch, so a protected one is denied', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    w.git.branch = 'main'
    for (const command of ['git push', 'git push origin', 'git push -u origin HEAD', 'git push --follow-tags']) {
      expect((await bash($, command)).deny, command).toContain('current branch `main`, a protected branch')
    }
    w.git.branch = 'release/1.2'
    expect((await bash($, 'git push')).deny).toContain('current branch `release/1.2`')
    expect(w.ran).toEqual([])
    w.git.branch = 'andersonsilva/topic'
    expect((await bash($, 'git push')).deny).toBeUndefined()
    expect(w.ran).toEqual(['git push'])
  })

  test('enforce: the branch is looked up where the command runs (-C), and one that cannot be read is unknown', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    await bash($, 'git -C ../wt push')
    expect(w.branchLookups).toEqual([['-C', '../wt']])
    w.git.exitCode = 128
    expect((await bash($, 'git push')).deny).toContain('could not tell which one')
    w.git.exitCode = 0
    w.git.branch = 'HEAD'
    expect((await bash($, 'git push')).deny).toContain('could not tell which one')
    w.git.throws = true
    expect((await bash($, 'git push')).deny).toContain('could not tell which one')
    expect((await bash($, 'cd sub && git push')).deny).toContain('cannot be read from the text')
    // A named branch needs no lookup, so none of that touches it.
    expect((await bash($, 'git push origin feature/x')).deny).toBeUndefined()
  })

  test('enforce: a commit, a reset or a checkout of the lead is routed to the git role; reading is not', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    expect((await bash($, 'git commit -m "x"')).deny).toContain('Delegate `git commit` to the `git` role')
    expect((await bash($, 'git add a.ts && git commit -m x')).deny).toContain('Delegate `git add` to the `git` role')
    expect((await bash($, 'git checkout main')).deny).toContain('Delegate `git checkout` to the `git` role')
    expect((await bash($, 'gh pr create --title t')).deny).toContain('PR/MR work goes to the git role')
    expect((await bash($, 'git diff HEAD~1 && git log -1')).deny).toBeUndefined()
    expect((await bash($, 'eval "$CMD"')).deny).toBeUndefined()
  })

  test('shadow: nothing is denied and the journal says what enforce would have', { options: { flow: 'shadow' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    w.git.branch = 'main'
    expect((await bash($, 'git push')).deny).toBeUndefined()
    expect((await bash($, 'git commit -m x')).deny).toBeUndefined()
    expect((await bash($, 'git push origin release/2')).deny).toBeUndefined()
    expect(w.ran).toHaveLength(3)
    const entries = w.journal().filter(entry => entry.event === 'git')
    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({ kind: 'decision', condition: 'git_gate', action: 'allow', wouldBe: 'block', mode: 'shadow', detail: 'lead: git push' })
    expect(entries[0]?.reason).toContain('protected branch')
    expect(entries[1]).toMatchObject({ detail: 'lead: git commit', wouldBe: 'block' })
    expect(w.seen.toasts).toEqual([])
  })

  test('off: nothing is read, run or journaled', { options: { flow: 'off' } }, async ($, on) => {
    const w = gitWorld(on)
    await start($)
    const before = w.calls.length
    const files = [...w.files.keys()]
    expect((await bash($, 'git push origin main')).deny).toBeUndefined()
    expect((await bash($, 'git commit -m x', 'dev-1')).deny).toBeUndefined()
    expect(w.calls.length).toBe(before)
    expect(w.ran).toHaveLength(2)
    expect([...w.files.keys()]).toEqual(files)
  })

  test('the default mode is shadow', async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    expect((await bash($, 'git push origin main')).deny).toBeUndefined()
    expect(w.journal().at(-1)).toMatchObject({ event: 'git', mode: 'shadow', wouldBe: 'block' })
  })

  test('without a plan the lead is still held, and nothing is written', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on, { plan: false })
    await start($)
    const files = [...w.files.keys()]
    expect((await bash($, 'git push origin main')).deny).toContain('protected branch `main`')
    w.git.branch = 'master'
    expect((await bash($, 'git push')).deny).toContain('current branch `master`')
    expect((await bash($, 'git commit -m x')).deny).toContain('git` role')
    expect((await bash($, 'git push origin feature')).deny).toBeUndefined()
    expect([...w.files.keys()]).toEqual(files)
  })

  test('without a plan shadow journals nothing and denies nothing', { options: { flow: 'shadow' } }, async ($, on) => {
    const w = gitWorld(on, { plan: false })
    await start($)
    const files = [...w.files.keys()]
    expect((await bash($, 'git push origin main')).deny).toBeUndefined()
    expect([...w.files.keys()]).toEqual(files)
  })

  test('the journal never holds the command: a credential in a URL stays out', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    await bash($, 'git push https://user:s3cret-token@example.com/x.git main')
    expect(w.files.get(JOURNAL)).not.toContain('s3cret-token')
    expect(w.journal().at(-1)).toMatchObject({ event: 'git', detail: 'lead: git push' })
  })

  test('a failing journal does not change the answer', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    // The journal is a file the host can no longer write.
    w.faults.journal = true
    expect((await bash($, 'git push origin main')).deny).toContain('protected branch `main`')
    expect(w.seen.toasts.join('\n')).toContain('git gate journal:')
  })
})

describe('what the first review found', () => {
  test('enforce: a comment does not hide a bare push, and an abbreviated --repo is read', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    w.git.branch = 'main'
    expect((await bash($, 'git push origin # deploy')).deny).toContain('current branch `main`')
    expect((await bash($, 'git push --rep=origin main')).deny).toContain('protected branch `main`')
    expect((await bash($, 'git push --rep origin')).deny).toContain('current branch `main`')
    expect(w.ran).toEqual([])
  })

  test('enforce: the git role cannot run a hidden git, nor write to a protected branch', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    w.agents.push({ id: 'git-1', description: 'Git operations', type: 'pantheon:git', status: 'running' })
    expect((await bash($, 'P=push; git $P origin main', 'git-1')).deny).toContain('hidden')
    expect((await bash($, 'echo "git push origin main" | sh', 'git-1')).deny).toContain('hidden')
    expect((await bash($, 'gh api -X POST repos/o/r/git/refs -f ref=refs/heads/main', 'git-1')).deny).toContain('Changing branches')
    expect((await bash($, 'git branch -D main', 'git-1')).deny).toContain('protected branch')
    // Writing to the checked-out branch is looked up like the lead's push.
    w.git.branch = 'main'
    expect((await bash($, 'git commit -m x', 'git-1')).deny).toContain('current branch `main`')
    expect((await bash($, 'git checkout -b andersonsilva/x && git commit -m x', 'git-1')).deny).toBeUndefined()
    w.git.branch = 'feature/x'
    expect((await bash($, 'git commit -m x', 'git-1')).deny).toBeUndefined()
    expect(w.branchLookups).toEqual([[], []])
  })

  test('enforce: -c, the environment and command URLs cannot hand git a program', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    expect((await bash($, 'git -c core.pager="sh -c x" log')).deny).toContain('-c core.pager')
    expect((await bash($, 'GIT_PAGER=x git log')).deny).toContain('Do not set environment')
    expect((await bash($, 'git fetch "ext::sh -c id"')).deny).toContain('ext::')
    expect((await bash($, 'git fetch --upload-pack="sh -c x" origin')).deny).toContain('another program')
    expect((await bash($, 'git push --receive-pack=x origin feature')).deny).toContain('receiving side')
    expect((await bash($, 'git -c color.ui=never -c user.name=x status')).deny).toBeUndefined()
  })

  test('enforce: Monitor runs a shell command and is held the same way', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    const monitor = (command?: string, agentId?: string) => $.tool.call({
      tool: 'Monitor', description: 'watch', timeout_ms: 1000, ...(command ? { command } : { ws: { url: 'wss://x' } }), ...(agentId ? { agentId } : {}),
    } as never)
    expect((await monitor('git push origin main')).deny).toContain('protected branch `main`')
    expect((await monitor('git commit -m x')).deny).toContain('Delegate `git commit`')
    expect((await monitor('git log -1 --oneline')).deny).toBeUndefined()
    expect((await monitor()).deny).toBeUndefined()
    expect(w.ran).toEqual(['git log -1 --oneline', '<ws>'])
  })

  test('shadow: Monitor is journaled and let through', { options: { flow: 'shadow' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    const out = await $.tool.call({ tool: 'Monitor', description: 'watch', timeout_ms: 1000, command: 'git push origin main' } as never)
    expect(out.deny).toBeUndefined()
    expect(w.journal().at(-1)).toMatchObject({ event: 'git', action: 'allow', wouldBe: 'block', detail: 'lead: git push' })
  })

  test('enforce: the push settings are read for a push that does not write src:dst', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    expect((await bash($, 'git push origin HEAD:feature/x')).deny).toBeUndefined()
    expect((await bash($, 'git push --tags origin')).deny).toBeUndefined()
    expect(w.configLookups).toEqual([])
    expect((await bash($, 'git push')).deny).toBeUndefined()
    expect(w.configLookups).toEqual([[]])
    w.git.config = ['remote.origin.push refs/heads/*:refs/heads/*']
    expect((await bash($, 'git push')).deny).toContain('push configuration')
    w.git.config = ['push.default upstream']
    expect((await bash($, 'git push -u origin HEAD')).deny).toContain('push.default')
    // A lookup git fails (not "no such key") is unknown.
    w.git.config = []
    w.git.configExit = 128
    expect((await bash($, 'git push')).deny).toContain('could not be read')
    // A destination written out is not affected by any of it; a source alone is, because git picks the destination.
    expect((await bash($, 'git push origin feature/x:feature/x')).deny).toBeUndefined()
    expect((await bash($, 'git push origin feature/x')).deny).toContain('could not be read')
  })

  test('a plan whose id was edited after approval is still journaled under the approved id', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    w.files.set(`${ROOT}/${PLAN}`, planMd({ ...FLOW, planId: 'renamed' }))
    expect((await bash($, 'git push origin main')).deny).toContain('protected branch `main`')
    expect(w.journal().at(-1)).toMatchObject({ event: 'git', action: 'block' })
    expect(w.files.has(`${ROOT}/.pantheon/flow/renamed/journal.jsonl`)).toBe(false)
  })

  test('the journal redacts what the reason quotes', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    const id = await developer($, w)
    const token = join('gh', 'p_abcdefghijklmnopqrstuvwxyz0123456789')
    const out = await bash($, `git add -- ${token}.ts`, id)
    // The model is told the path it named; the file keeps only the marker.
    expect(out.deny).toContain('is not one of your task\'s files')
    expect(w.files.get(JOURNAL)).not.toContain(token)
    expect(w.journal().at(-1)?.reason).toContain('[redacted]')
  })
})

describe('what the second review found', () => {
  test('enforce: a command that runs another command does not hide the git it runs, for any actor', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    w.agents.push({ id: 'git-1', description: 'Git operations', type: 'pantheon:git', status: 'running' })
    w.agents.push({ id: 'qa-1', description: 'Verify', type: 'pantheon:qa', status: 'running' })
    for (const id of [undefined, 'git-1', 'qa-1']) {
      for (const command of ['op run -- git push origin main', 'mise exec -- git push origin main', 'flock /tmp/l git push origin main', 'xcrun gh pr merge 1']) {
        expect((await bash($, command, id)).deny, `${id}: ${command}`).toContain('hidden')
      }
    }
    // A wrapper it can read through is read, so the push is judged as any other.
    expect((await bash($, 'caffeinate git push origin main')).deny).toContain('protected branch `main`')
    expect((await bash($, 'caffeinate git push origin feature/x:feature/x')).deny).toBeUndefined()
    // A `git` that is a name is not a command.
    expect((await bash($, 'brew install git curl && pytest -k git tests/')).deny).toBeUndefined()
    expect(w.ran).toHaveLength(2)
  })

  test('enforce: a push that does not write src:dst follows the push settings, to a protected branch or not', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    w.git.config = ['remote.origin.push refs/heads/foo:refs/heads/main']
    expect((await bash($, 'git push origin foo')).deny).toContain('push configuration')
    w.git.config = ['push.default upstream']
    expect((await bash($, 'git push -u origin andersonsilva/foo')).deny).toContain('push configuration')
    expect((await bash($, 'git push origin andersonsilva/foo:andersonsilva/foo')).deny).toBeUndefined()
    w.git.config = []
    expect((await bash($, 'git push -u origin andersonsilva/foo')).deny).toBeUndefined()
  })

  test('enforce: GitLab push options cannot open or merge a merge request, and a failing switch does not fix the branch', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    expect((await bash($, 'git push -o merge_request.create -o merge_request.merge_when_pipeline_succeeds origin feat:feat')).deny).toContain('merge_request')
    expect((await bash($, 'git push -o ci.skip origin feat:feat')).deny).toBeUndefined()
    // A line the lead cannot run through the git role, with the role off, to see the separator at work.
    w.agents.push({ id: 'git-1', description: 'Git operations', type: 'pantheon:git', status: 'running' })
    w.git.branch = 'main'
    expect((await bash($, 'git switch -c x; git commit -m y', 'git-1')).deny).toContain('not joined')
    expect((await bash($, 'git switch -c x && git commit -m y', 'git-1')).deny).toBeUndefined()
  })

  test('enforce: aliases, extensions and unknown gh groups are held', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    w.agents.push({ id: 'git-1', description: 'Git operations', type: 'pantheon:git', status: 'running' })
    expect((await bash($, 'gh alias set mm "pr merge --admin"')).deny).toContain('changes state on the forge')
    expect((await bash($, 'gh alias set mm "pr merge --admin"', 'git-1')).deny).toContain('Aliases and extensions')
    expect((await bash($, 'gh mm 1', 'git-1')).deny).toContain('not a `gh` or `glab` command')
    expect((await bash($, 'gh issue comment 1 -b x')).deny).toBeUndefined()
    expect((await bash($, 'gh pr view 3', 'git-1')).deny).toBeUndefined()
  })

  test('enforce: the branch and the settings are read where the subagent works', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    // A git role spawned in another checkout, and an agent it spawns without one: both run there.
    w.engine.spawnId = 'git-9'
    await $.agent.spawn({ ...spawnBase, tool_use_id: 'tu-9', description: 'Git operations', subagentType: 'pantheon:git', cwd: '/repo-wt' } as never)
    w.agents.push({ id: 'git-9', description: 'Git operations', type: 'pantheon:git', status: 'running' })
    w.git.branch = 'main'
    expect((await bash($, 'git commit -m x', 'git-9')).deny).toContain('current branch `main`')
    expect(w.lookupCwds).toEqual(['/repo-wt'])
    w.git.branch = 'feature/x'
    expect((await bash($, 'git commit -m x', 'git-9')).deny).toBeUndefined()
    w.agents.push({ id: 'kid-9', description: 'helper', type: 'general-purpose', status: 'running', parentId: 'git-9' })
    w.lookupCwds.length = 0
    expect((await bash($, 'git push', 'kid-9')).deny).toBeUndefined()
    expect(w.lookupCwds).toEqual(['/repo-wt', '/repo-wt'])
    // The main session and a subagent with no cwd of its own run in the session's.
    w.lookupCwds.length = 0
    w.engine.spawnId = 'git-1'
    await $.agent.spawn({ ...spawnBase, tool_use_id: 'tu-1', description: 'Git operations', subagentType: 'pantheon:git' } as never)
    w.agents.push({ id: 'git-1', description: 'Git operations', type: 'pantheon:git', status: 'running' })
    await bash($, 'git commit -m x', 'git-1')
    await bash($, 'git push')
    expect(w.lookupCwds).toEqual([undefined, undefined, undefined])
  })

  test('enforce: an agent started with isolation works in a worktree nothing names, so its lookups are unknown', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    await $.tool.call({ tool: 'Agent', description: 'Git operations', prompt: 'p', subagent_type: 'pantheon:git', isolation: 'worktree', tool_use_id: 'tu-iso' } as never)
    w.engine.spawnId = 'git-iso'
    await $.agent.spawn({ ...spawnBase, tool_use_id: 'tu-iso', description: 'Git operations', subagentType: 'pantheon:git' } as never)
    w.agents.push({ id: 'git-iso', description: 'Git operations', type: 'pantheon:git', status: 'running' })
    w.lookupCwds.length = 0
    expect((await bash($, 'git commit -m x', 'git-iso')).deny).toContain('could not tell which one')
    expect(w.lookupCwds).toEqual([])
    // What the git role does that needs no lookup is not held back.
    expect((await bash($, 'git status', 'git-iso')).deny).toBeUndefined()
  })
})

describe('a task\'s developer', () => {
  test('enforce: add and commit of its own files with the task id go through; unowned files, a missing id and a push do not', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    const id = await developer($, w)
    const ok = 'git add -- src/a.ts src/c.ts && git commit -m "feat(x): do it [T1]" -- src/a.ts src/c.ts'
    expect((await bash($, ok, id)).deny).toBeUndefined()
    expect((await bash($, 'git status && git diff --stat', id)).deny).toBeUndefined()
    expect((await bash($, 'npm test', id)).deny).toBeUndefined()

    expect((await bash($, 'git add -- src/other.ts', id)).deny).toContain('`src/other.ts` is not one of your task\'s files')
    expect((await bash($, 'git commit -m "feat(x): do it [T1]" -- src/b/x.ts', id)).deny).toContain('`src/b/x.ts` is not one of your task\'s files')
    expect((await bash($, 'git commit -m "feat(x): do it" -- src/a.ts', id)).deny).toContain('[T1]')
    expect((await bash($, 'git add -A', id)).deny).toContain('never `-A`')
    expect((await bash($, 'git add .', id)).deny).toContain('explicitly')
    expect((await bash($, 'git commit --no-verify -m "x [T1]" -- src/a.ts', id)).deny).toContain('--no-verify')
    expect((await bash($, 'git push origin feature', id)).deny).toContain('Dev agents only run')
    expect((await bash($, 'git checkout main', id)).deny).toContain('route `git checkout` to the `git` role')
    expect((await bash($, 'git stash', id)).deny).toContain('route `git stash` to the `git` role')
    expect(w.ran).toHaveLength(3)
    expect(w.journal().at(-1)).toMatchObject({ event: 'git', task: 'T1', action: 'block', detail: 'developer: git stash' })
  })

  test('shadow journals the refusals with the task and lets them through', { options: { flow: 'shadow' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    const id = await developer($, w)
    expect((await bash($, 'git add -- src/other.ts', id)).deny).toBeUndefined()
    expect((await bash($, 'git push', id)).deny).toBeUndefined()
    expect(w.ran).toHaveLength(2)
    expect(w.journal().filter(entry => entry.event === 'git')).toMatchObject([
      { task: 'T1', action: 'allow', wouldBe: 'block', detail: 'developer: git add' },
      { task: 'T1', action: 'allow', wouldBe: 'block', detail: 'developer: git push' },
    ])
  })

  test('the path is resolved by the host: a file linked out of the task\'s files is not owned', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on, { realPaths: { '/repo/src/a.ts': '/repo/secrets/real.ts' } })
    await boot($, w)
    const id = await developer($, w)
    expect((await bash($, 'git add -- src/a.ts', id)).deny).toContain('`src/a.ts` is not one of your task\'s files')
    expect((await bash($, 'git add -- src/c.ts', id)).deny).toBeUndefined()
  })

  test('a subagent of the developer is held to the same task', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    const id = await developer($, w)
    w.agents.push({ id: 'kid-1', description: 'helper', type: 'general-purpose', status: 'running', parentId: id })
    expect((await bash($, 'git add -- src/other.ts', 'kid-1')).deny).toContain('not one of your task\'s files')
    expect((await bash($, 'git add -- src/a.ts', 'kid-1')).deny).toBeUndefined()
  })

  test('enforce: a failure of the host while reading ownership fails open', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    const id = await developer($, w)
    w.faults.stat = true
    expect((await bash($, 'git add -- src/other.ts', id)).deny).toBeUndefined()
    expect(w.ran).toEqual(['git add -- src/other.ts'])
    expect(w.seen.toasts.join('\n')).toContain('the flow failed open')
  })
})

describe('other agents', () => {
  test('the git role keeps checkout, PR/MR and stash; its push is refused', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    w.agents.push({ id: 'git-1', description: 'Git operations', type: 'pantheon:git', status: 'running' })
    expect((await bash($, 'git checkout -b feature/y && git stash', 'git-1')).deny).toBeUndefined()
    expect((await bash($, 'gh pr create --title "feat: x" --body y', 'git-1')).deny).toBeUndefined()
    expect((await bash($, 'git push origin feature/y', 'git-1')).deny).toContain('The lead pushes')
    expect((await bash($, 'gh pr merge 3', 'git-1')).deny).toContain('person\'s call')
    expect(w.ran).toHaveLength(2)
  })

  test('a developer or ux no task links is held to the same verbs and flags, with every path its own', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    w.agents.push({ id: 'dev-free', description: 'no task', type: 'pantheon:developer', status: 'running' })
    w.agents.push({ id: 'ux-free', description: 'no task', type: 'pantheon:ux', status: 'running' })
    for (const id of ['dev-free', 'ux-free']) {
      expect((await bash($, 'git add -- anywhere/x.ts && git commit -m "feat: x" -- anywhere/x.ts', id)).deny, id).toBeUndefined()
      expect((await bash($, 'git commit -am x', id)).deny, id).toContain('stages everything')
      expect((await bash($, 'git add -A', id)).deny, id).toContain('never `-A`')
      expect((await bash($, 'git push origin main', id)).deny, id).toContain('Dev agents only run')
    }
    expect(w.ran).toHaveLength(2)
  })

  test('the read-only roles and council seats may only read', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    for (const [id, type] of [['qa-1', 'pantheon:qa'], ['arch-1', 'pantheon:architect'], ['read-1', 'pantheon:code-reader'], ['docs-1', 'pantheon:docs-reader'], ['seat-1', 'pantheon:councillor-alpha']] as const) {
      w.agents.push({ id, description: 'x', type, status: 'running' })
      expect((await bash($, 'git log -3 && git diff --stat', id)).deny, id).toBeUndefined()
      expect((await bash($, 'git commit -am x', id)).deny, id).toContain('read-only')
      expect((await bash($, 'git push origin feature', id)).deny, id).toContain('read-only')
    }
  })

  test('any other agent, listed or not, gets the lead\'s rules: no push to a protected branch, no commit', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    w.agents.push({ id: 'gp-1', description: 'general work', type: 'general-purpose', status: 'running' })
    w.agents.push({ id: 'ex-1', description: 'Explore', type: 'Explore', status: 'running' })
    for (const id of ['gp-1', 'ex-1', 'stranger']) {
      expect((await bash($, 'git push origin main', id)).deny, id).toContain('protected branch `main`')
      expect((await bash($, 'git commit -am x', id)).deny, id).toContain('Delegate `git commit` to the `git` role')
      expect((await bash($, 'gh pr merge 3', id)).deny, id).toContain('PR/MR work')
      expect((await bash($, 'git status && git push origin feature/x:feature/x', id)).deny, id).toBeUndefined()
    }
    // The branch and the settings are read where the agent works: for one the engine does not list, that is not knowable.
    expect((await bash($, 'git push origin feature/x', 'gp-1')).deny).toBeUndefined()
    expect((await bash($, 'git push origin feature/x', 'stranger')).deny).toContain('could not be read')
    // A bare push is held to the checked-out branch for them too.
    w.git.branch = 'main'
    expect((await bash($, 'git push', 'gp-1')).deny).toContain('current branch `main`')
  })

  test('commands that run no git cost no agent lookup and no process', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    const id = await developer($, w)
    const before = w.calls.length
    expect((await bash($, 'npm run build && ls -la', id)).deny).toBeUndefined()
    expect((await bash($, 'npm test')).deny).toBeUndefined()
    expect(w.calls.slice(before)).toEqual([])
  })

  test('enforce: an engine that cannot list the agents fails open and says so', { options: { flow: 'enforce' } }, async ($, on) => {
    const w = gitWorld(on)
    await boot($, w)
    w.faults.list = true
    expect((await bash($, 'git push origin main', 'unknown-1')).deny).toBeUndefined()
    expect(w.ran).toHaveLength(1)
    expect(w.seen.toasts.join('\n')).toContain('the flow failed open')
  })
})
