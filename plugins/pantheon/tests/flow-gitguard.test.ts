import { describe, expect, test } from 'claude-code/testing'
import { classifyGitCommand } from '../hooks/flow/gitgate'
import { actorOfType, cwdOfAgent, gitGate, usesGit } from '../hooks/flow/gitguard'
import type { GitCall, GitHost } from '../hooks/flow/gitguard'

// The git gate over the classifier: what a push or a commit names, which branch is checked out, what the push settings say
// and what a developer owns.

type Branch = string | undefined | ((dirArgs: string[]) => string | undefined)

/** A host that answers from a table and remembers what it was asked. `config` is the push settings' lines. */
function host(opts: { branch?: Branch; owns?: string[]; config?: string[] | undefined } = {}) {
  const asked = { branch: [] as string[][], owned: [] as string[][], config: [] as string[][] }
  const impl: GitHost = {
    branch: async dirArgs => {
      asked.branch.push(dirArgs)
      return typeof opts.branch === 'function' ? opts.branch(dirArgs) : opts.branch
    },
    owned: async paths => {
      asked.owned.push(paths)
      return paths.filter(path => (opts.owns ?? []).includes(path))
    },
    config: async dirArgs => {
      asked.config.push(dirArgs)
      return 'config' in opts ? opts.config : []
    },
  }
  return { impl, asked }
}

const call = (actor: GitCall['actor'], command: string, extra: Partial<GitCall> = {}): GitCall => ({ command, actor, gitRole: true, ...extra })
const reasonOf = (outcome: Awaited<ReturnType<typeof gitGate>>) => (outcome.allow ? '' : outcome.reason)

describe('usesGit', () => {
  test('only a line that runs git or a forge tool is looked at', () => {
    expect(usesGit('npm test && echo done')).toBe(false)
    expect(usesGit('ls -la | grep git')).toBe(false)
    expect(usesGit('git status')).toBe(true)
    expect(usesGit('cd x && git push')).toBe(true)
    expect(usesGit('gh pr create')).toBe(true)
    expect(usesGit('bash -c "git push"')).toBe(true)
    expect(usesGit(classifyGitCommand('git status'))).toBe(true)
    expect(usesGit(classifyGitCommand('npm test'))).toBe(false)
  })
})

describe('the actor of an agent no task links', () => {
  test('a role by its type, council seats as read-only, everything else as the lead', () => {
    expect(actorOfType('pantheon:git')).toBe('git')
    expect(actorOfType('pantheon:developer')).toBe('developer')
    expect(actorOfType('pantheon:ux')).toBe('ux')
    for (const role of ['code-reader', 'docs-reader', 'architect', 'qa'] as const) expect(actorOfType(`pantheon:${role}`)).toBe(role)
    expect(actorOfType('pantheon:councillor-alpha')).toBe('councillor')
    for (const type of ['general-purpose', 'Explore', 'Plan', 'pantheon:unknown', 'someone:git', undefined]) expect(actorOfType(type)).toBe('lead')
  })
})

describe('the lead\'s push names the checked-out branch', () => {
  test('a push that writes src:dst is decided by the text alone', async () => {
    const h = host({ branch: 'main', config: ['push.default upstream', 'remote.origin.push refs/heads/*:refs/heads/main'] })
    expect((await gitGate(call('lead', 'git push origin HEAD:feature/x'), h.impl)).allow).toBe(true)
    expect((await gitGate(call('lead', 'git push origin feature/x:feature/x refs/heads/a:refs/heads/b'), h.impl)).allow).toBe(true)
    expect((await gitGate(call('lead', 'git push --tags origin'), h.impl)).allow).toBe(true)
    expect(reasonOf(await gitGate(call('lead', 'git push origin main'), h.impl))).toContain('protected branch `main`')
    expect(reasonOf(await gitGate(call('lead', 'git push origin HEAD:release/1.2'), h.impl))).toContain('protected branch `release/1.2`')
    expect(h.asked.branch).toEqual([])
    expect(h.asked.config).toEqual([])
  })

  test('a refspec with no :dst does not say where it goes: the settings are read, the branch is not', async () => {
    const plain = host({ branch: 'main', config: [] })
    for (const command of ['git push origin feature/x', 'git push -u origin andersonsilva/foo', 'git push origin refs/heads/foo', 'git push origin a b']) {
      expect((await gitGate(call('lead', command), plain.impl)).allow, command).toBe(true)
    }
    expect(plain.asked.branch).toEqual([])
    expect(plain.asked.config).toHaveLength(4)
    // The settings that send it elsewhere: a configured refspec, a mirror, push.default upstream/tracking/matching.
    for (const line of ['remote.origin.push refs/heads/foo:refs/heads/main', 'remote.origin.mirror true', 'push.default upstream', 'push.default tracking', 'push.default matching']) {
      for (const command of ['git push origin foo', 'git push -u origin andersonsilva/foo', 'git push origin foo bar']) {
        const outcome = await gitGate(call('lead', command), host({ branch: 'feature', config: [line] }).impl)
        expect(outcome.allow, `${command} with ${line}`).toBe(false)
        expect(reasonOf(outcome)).toContain('does not write its destination out')
      }
    }
    // A lookup that fails denies, and one refspec without :dst is enough.
    expect((await gitGate(call('lead', 'git push origin foo'), host({ branch: 'feature', config: undefined }).impl)).allow).toBe(false)
    expect((await gitGate(call('lead', 'git push origin a:b foo'), host({ branch: 'feature', config: ['push.default upstream'] }).impl)).allow).toBe(false)
    // The directory it runs in must be readable too.
    for (const command of ['cd sub && git push origin foo', 'git -C "$D" push origin foo', 'git --git-dir=x push origin foo']) {
      expect((await gitGate(call('lead', command), host({ branch: 'feature' }).impl)).allow, command).toBe(false)
    }
    expect((await gitGate(call('lead', 'git -C ../w push origin foo'), host({ branch: 'feature' }).impl)).allow).toBe(true)
  })

  test('a bare push, a push to a remote and a push of HEAD go to the current branch', async () => {
    for (const command of ['git push', 'git push origin', 'git push -u origin HEAD', 'git push origin @', 'git push --follow-tags', 'git push --repo=origin', 'git push --rep=origin', 'git push --rep origin', 'git-push']) {
      const onFeature = host({ branch: 'feature/x' })
      expect((await gitGate(call('lead', command), onFeature.impl)).allow, command).toBe(true)
      expect(onFeature.asked.branch, command).toEqual([[]])
      for (const protectedBranch of ['main', 'master', 'develop', 'release', 'release/1.2']) {
        const outcome = await gitGate(call('lead', command), host({ branch: protectedBranch }).impl)
        expect(outcome.allow, `${command} on ${protectedBranch}`).toBe(false)
        expect(reasonOf(outcome)).toContain(`current branch \`${protectedBranch}\``)
      }
    }
  })

  test('a comment does not hide that the push has no destination', async () => {
    for (const command of ['git push origin # deploy', 'git push # origin feature', 'git push -u origin HEAD # to main']) {
      const outcome = await gitGate(call('lead', command), host({ branch: 'main' }).impl)
      expect(outcome.allow, command).toBe(false)
      expect(reasonOf(outcome), command).toContain('current branch `main`')
    }
  })

  test('an ambiguous name that git abbreviates as heads/main is still main', async () => {
    expect(reasonOf(await gitGate(call('lead', 'git push'), host({ branch: 'heads/main' }).impl))).toContain('current branch `main`')
    expect(reasonOf(await gitGate(call('lead', 'git push'), host({ branch: 'refs/heads/release/2' }).impl))).toContain('current branch `release/2`')
  })

  test('a branch that cannot be read is unknown and denied', async () => {
    for (const branch of [undefined, '', 'HEAD']) {
      const outcome = await gitGate(call('lead', 'git push'), host({ branch }).impl)
      expect(outcome.allow, String(branch)).toBe(false)
      expect(reasonOf(outcome)).toContain('could not tell which one')
    }
  })

  test('where the push runs: -C is looked up there, anything else that moves the lookup is unknown', async () => {
    const elsewhere = host({ branch: dirArgs => (dirArgs.includes('../other') ? 'main' : 'feature') })
    expect(reasonOf(await gitGate(call('lead', 'git -C ../other push'), elsewhere.impl))).toContain('current branch `main`')
    expect(elsewhere.asked.branch).toEqual([['-C', '../other']])
    const mine = host({ branch: 'feature' })
    expect((await gitGate(call('lead', 'git -C ../mine push'), mine.impl)).allow).toBe(true)
    expect(mine.asked.config).toEqual([['-C', '../mine']])

    for (const command of ['cd sub && git push', 'git -C "$DIR" push', 'git --git-dir=/x/.git push', 'git -C ~/x push']) {
      const h = host({ branch: 'feature' })
      const outcome = await gitGate(call('lead', command), h.impl)
      expect(outcome.allow, command).toBe(false)
      expect(h.asked.branch, command).toEqual([])
    }
  })

  test('a destination that is not literal could be any branch', async () => {
    for (const command of ['git push origin "$BRANCH"', 'git push origin $(git branch --show-current)', 'git push origin feature "$X"']) {
      const outcome = await gitGate(call('lead', command), host({ branch: 'feature' }).impl)
      expect(outcome.allow, command).toBe(false)
      expect(reasonOf(outcome), command).toContain('not literal')
    }
  })

  test('with the git role disabled the lead switches branches, and the line is followed', async () => {
    const lead = (command: string, branch = 'feature') => {
      const h = host({ branch })
      return gitGate(call('lead', command, { gitRole: false }), h.impl).then(outcome => ({ outcome, h }))
    }
    expect((await lead('git switch main')).outcome.allow).toBe(true)
    // What the line switched to is the branch for what follows, protected or not.
    expect(reasonOf((await lead('git switch main && git push')).outcome)).toContain('current branch `main`')
    expect(reasonOf((await lead('git checkout -b main2 && git commit -m x')).outcome)).toBe('')
    // Anything it cannot follow makes the branch unknown.
    expect(reasonOf((await lead('git checkout main; git push origin')).outcome)).toContain('after `git checkout`')
    expect(reasonOf((await lead('git rebase main && git push')).outcome)).toContain('after `git rebase`')
    // What leaves the branch's name alone does not matter, and a push that names its branch never cared.
    expect((await lead('git commit -m x && git push')).outcome.allow).toBe(true)
    expect((await lead('git add a.ts && git commit -m x && git push')).outcome.allow).toBe(true)
    expect(reasonOf((await lead('git commit -m x && git push', 'main')).outcome)).toContain('current branch `main`')
    expect((await lead('git switch feature && git push origin feature')).outcome.allow).toBe(true)
  })

  test('one lookup per place, and no more than four places', async () => {
    const two = host({ branch: 'feature' })
    expect((await gitGate(call('lead', 'git push && git push origin'), two.impl)).allow).toBe(true)
    expect(two.asked.branch).toEqual([[]])
    expect(two.asked.config).toEqual([[]])
    const many = host({ branch: 'feature' })
    const outcome = await gitGate(call('lead', ['a', 'b', 'c', 'd', 'e'].map(dir => `git -C ${dir} push`).join(' && ')), many.impl)
    expect(outcome.allow).toBe(false)
    expect(reasonOf(outcome)).toContain('more than 4 places')
    expect(many.asked.branch).toHaveLength(4)
  })

  test('what the classifier denies is not looked up', async () => {
    const h = host({ branch: 'feature' })
    expect(reasonOf(await gitGate(call('lead', 'git commit -m x'), h.impl))).toContain('Delegate `git commit` to the `git` role')
    expect(reasonOf(await gitGate(call('lead', 'git push --force origin'), h.impl))).toContain('Forced push')
    expect((await gitGate(call('lead', 'git status'), h.impl)).allow).toBe(true)
    expect(h.asked.branch).toEqual([])
    expect(h.asked.config).toEqual([])
  })

  test('the summary names the commands, never their arguments', async () => {
    const outcome = await gitGate(call('lead', 'git push https://user:s3cret@example.com/x.git main && gh pr create --title "t"'), host().impl)
    expect(outcome.allow).toBe(false)
    if (!outcome.allow) {
      expect(outcome.summary).toBe('git push, gh pr')
    }
  })
})

describe('the push settings decide where a push with no destination goes', () => {
  const push = (config: string[] | undefined, command = 'git push') => {
    const h = host({ branch: 'feature/x', ...(config === undefined ? { config: undefined } : { config }) })
    return gitGate(call('lead', command), h.impl).then(outcome => ({ outcome, h }))
  }

  test('a configured push refspec, a mirror and push.default upstream, tracking or matching are denied', async () => {
    for (const line of ['remote.origin.push refs/heads/*:refs/heads/*', 'remote.upstream.push HEAD:main', 'remote.origin.mirror true', 'push.default upstream', 'push.default tracking', 'push.default matching', 'PUSH.DEFAULT Upstream']) {
      const { outcome } = await push([line])
      expect(outcome.allow, line).toBe(false)
      expect(reasonOf(outcome), line).toContain('push configuration')
    }
  })

  test('plain settings pass, and the lookup is a single read', async () => {
    for (const lines of [[], ['push.default simple'], ['push.default current'], ['remote.origin.mirror false']]) {
      const { outcome, h } = await push(lines)
      expect(outcome.allow, lines.join()).toBe(true)
      expect(h.asked.config).toEqual([[]])
    }
  })

  test('a lookup that fails is unknown, and a push that writes src:dst or only tags never asks', async () => {
    const failed = await push(undefined)
    expect(failed.outcome.allow).toBe(false)
    expect(reasonOf(failed.outcome)).toContain('could not be read')
    const explicit = await push(['push.default upstream'], 'git push origin feature/x:feature/x')
    expect(explicit.outcome.allow).toBe(true)
    expect(explicit.h.asked.config).toEqual([])
    const tags = await push(['push.default upstream'], 'git push --tags origin')
    expect(tags.outcome.allow).toBe(true)
    expect(tags.h.asked.config).toEqual([])
  })

  test('a branch created on the line and left tracking main is caught by push.default', async () => {
    const h = host({ branch: 'feature', config: ['push.default upstream'] })
    const outcome = await gitGate(call('lead', 'git checkout -b topic origin/main && git push', { gitRole: false }), h.impl)
    expect(outcome.allow).toBe(false)
    expect(reasonOf(outcome)).toContain('push.default')
  })

  test('a config write on the same line makes the destination unknown', async () => {
    // With the git role disabled the lead may write config; `config` and `remote` no longer keep the branch's destination.
    const lead = (command: string) => gitGate(call('lead', command, { gitRole: false }), host({ branch: 'feature' }).impl)
    expect((await lead('git config user.name x && git push')).allow).toBe(false)
    expect((await lead('git remote add x y && git push')).allow).toBe(false)
    expect((await lead('git config remote.origin.push HEAD:main && git push origin')).allow).toBe(false)
  })
})

describe('the git role is held to the current branch for what writes to it', () => {
  // `null` is a branch git cannot read.
  const gitRole = (command: string, branch: string | null = 'feature/x', extra: Partial<GitCall> = {}) => {
    const h = host({ branch: branch ?? undefined })
    return gitGate(call('git', command, extra), h.impl).then(outcome => ({ outcome, h }))
  }

  test('commit, merge, rebase, reset, cherry-pick, revert, am and pull are denied on a protected branch', async () => {
    for (const verb of ['commit -m x', 'merge topic', 'rebase origin/main', 'reset --hard origin/x', 'cherry-pick abc', 'revert abc', 'am p.mbox', 'pull --ff-only']) {
      for (const branch of ['main', 'master', 'develop', 'release', 'release/1.2']) {
        const { outcome } = await gitRole(`git ${verb}`, branch)
        expect(outcome.allow, `${verb} on ${branch}`).toBe(false)
        expect(reasonOf(outcome)).toContain(`current branch \`${branch}\``)
      }
      const onFeature = await gitRole(`git ${verb}`)
      expect(onFeature.outcome.allow, verb).toBe(true)
      expect(onFeature.h.asked.branch).toEqual([[]])
      // A branch that cannot be read is unknown.
      expect((await gitRole(`git ${verb}`, 'HEAD')).outcome.allow, verb).toBe(false)
      expect((await gitRole(`git ${verb}`, null)).outcome.allow, verb).toBe(false)
    }
  })

  test('reading, staging, checkout and switch ask for nothing', async () => {
    for (const command of ['git status', 'git log -3', 'git add a.ts', 'git checkout main', 'git switch main', 'git stash', 'git worktree add ../x', 'gh pr create --fill', 'git fetch origin']) {
      const { outcome, h } = await gitRole(command, 'main')
      expect(outcome.allow, command).toBe(true)
      expect(h.asked.branch, command).toEqual([])
    }
  })

  test('a branch the line creates or switches to is the branch for what follows', async () => {
    const run = (command: string) => gitRole(command, 'main')
    // Made on the line: nothing to look up, and a protected name is denied by name.
    const made = await run('git checkout -b andersonsilva/x && git commit -m y')
    expect(made.outcome.allow).toBe(true)
    expect(made.h.asked.branch).toEqual([])
    expect((await run('git switch -c andersonsilva/x && git commit -m y')).outcome.allow).toBe(true)
    expect((await run('git switch feature && git commit -m y')).outcome.allow).toBe(true)
    expect(reasonOf((await run('git switch main && git commit -m y')).outcome)).toContain('current branch `main`')
    // Other changes of branch cannot be followed.
    expect(reasonOf((await run('git checkout feature && git commit -m y')).outcome)).toContain('after `git checkout`')
    expect(reasonOf((await run('git switch --detach HEAD~1 && git commit -m y')).outcome)).toContain('after `git switch`')
    expect(reasonOf((await run('cd sub && git commit -m y')).outcome)).toContain('cannot be read from the text')
    // A commit that comes first still looks at the branch the line started on.
    expect(reasonOf((await run('git commit -m y && git checkout -b topic')).outcome)).toContain('current branch `main`')
  })

  test('where the write runs, a rebase that names a branch, and update-ref on HEAD', async () => {
    const elsewhere = host({ branch: dirArgs => (dirArgs.includes('wt') ? 'main' : 'feature') })
    expect(reasonOf(await gitGate(call('git', 'git -C wt commit -m x'), elsewhere.impl))).toContain('current branch `main`')
    expect((await gitGate(call('git', 'git -C other commit -m x'), elsewhere.impl)).allow).toBe(true)
    const onFeature = host({ branch: 'feature' })
    expect((await gitGate(call('git', 'git rebase --onto origin/main old'), onFeature.impl)).allow).toBe(true)
    expect((await gitGate(call('git', 'git rebase -x "make test" origin/main'), onFeature.impl)).allow).toBe(true)
    expect(reasonOf(await gitGate(call('git', 'git rebase origin/main main'), onFeature.impl))).toContain('names the branch to rebase')
    expect((await gitGate(call('git', 'git update-ref refs/heads/topic abc'), onFeature.impl)).allow).toBe(true)
    expect(reasonOf(await gitGate(call('git', 'git update-ref HEAD abc'), host({ branch: 'main' }).impl))).toContain('current branch `main`')
    expect((await gitGate(call('git', 'git update-ref HEAD abc'), onFeature.impl)).allow).toBe(true)
  })

  test('a lead acting as the git role is held the same way; with the role enabled it commits nothing', async () => {
    const acting = await gitGate(call('lead', 'git commit -m x', { gitRole: false }), host({ branch: 'main' }).impl)
    expect(reasonOf(acting)).toContain('current branch `main`')
    expect((await gitGate(call('lead', 'git commit -m x', { gitRole: false }), host({ branch: 'feature' }).impl)).allow).toBe(true)
    const routed = host({ branch: 'main' })
    expect(reasonOf(await gitGate(call('lead', 'git commit -m x'), routed.impl))).toContain('Delegate')
    expect(routed.asked.branch).toEqual([])
  })
})

describe('a developer commits its own task', () => {
  const dev = (command: string, h = host({ owns: ['src/a.ts'] })) => gitGate(call('developer', command, { task: 'T1' }), h.impl)

  test('add and commit of owned files with the task id are allowed', async () => {
    const h = host({ owns: ['src/a.ts'] })
    expect((await dev('git add -- src/a.ts && git commit -m "feat(x): do it [T1]" -- src/a.ts', h)).allow).toBe(true)
    expect(h.asked.owned).toEqual([['src/a.ts']])
  })

  test('a commit without the task id, or of a file the task does not own, is denied', async () => {
    expect(reasonOf(await dev('git commit -m "feat(x): do it" -- src/a.ts'))).toContain('[T1]')
    expect(reasonOf(await dev('git commit -m "feat(x): do it [T9]" -- src/a.ts'))).toContain('[T1]')
    expect(reasonOf(await dev('git commit -m "feat(x): do it [T1]" -- src/other.ts'))).toContain('`src/other.ts` is not one of your task\'s files')
    expect(reasonOf(await dev('git add -- src/a.ts src/other.ts'))).toContain('src/other.ts')
  })

  test('the task id must be in the commit\'s own text, not in --author or a trailer', async () => {
    expect(reasonOf(await dev('git commit --author "A [T1] <a@b.c>" -m "feat: x" -- src/a.ts'))).toContain('[T1]')
    expect(reasonOf(await dev('git commit --trailer "Refs: [T1]" -m "feat: x" -- src/a.ts'))).toContain('[T1]')
    expect((await dev('git commit --author "A <a@b.c>" -m "feat: x [T1]" -- src/a.ts')).allow).toBe(true)
    expect((await dev('git commit --message="feat: x [T1]" -- src/a.ts')).allow).toBe(true)
    expect((await dev('git commit -m feat -m "body [T1]" -- src/a.ts')).allow).toBe(true)
  })

  test('push, catch-all staging and everything else that changes state are denied; reading is not', async () => {
    expect(reasonOf(await dev('git push origin feature'))).toContain('Dev agents only run')
    expect(reasonOf(await dev('git add -A'))).toContain('never `-A`')
    expect(reasonOf(await dev('git commit --no-verify -m "x [T1]" -- src/a.ts'))).toContain('--no-verify')
    expect(reasonOf(await dev('git checkout main'))).toContain('route `git checkout` to the `git` role')
    expect((await dev('git status && git diff --stat')).allow).toBe(true)
  })

  test('only plain files are looked up with the host', async () => {
    const h = host({ owns: [] })
    await dev('git add -- . src/ "*.ts" src/a.ts', h)
    expect(h.asked.owned).toEqual([['src/a.ts']])
    const none = host()
    await dev('git add -A', none)
    expect(none.asked.owned).toEqual([])
  })

  test('with no task (outside a flow) the verbs and flags hold and the id is not asked for', async () => {
    const free = host({ owns: ['x.ts'] })
    expect((await gitGate(call('developer', 'git add -- x.ts && git commit -m "feat: x" -- x.ts'), free.impl)).allow).toBe(true)
    expect(reasonOf(await gitGate(call('developer', 'git commit -am x'), free.impl))).toContain('stages everything')
    expect(reasonOf(await gitGate(call('developer', 'git push origin feature'), free.impl))).toContain('Dev agents only run')
  })

  test('ux is held to the same rules', async () => {
    const h = host({ owns: ['ui/a.css'] })
    expect((await gitGate(call('ux', 'git commit -m "style: x [T2]" -- ui/a.css', { task: 'T2' }), h.impl)).allow).toBe(true)
    expect((await gitGate(call('ux', 'git push', { task: 'T2' }), h.impl)).allow).toBe(false)
  })
})

describe('the git role', () => {
  test('keeps checkout, switch, PR/MR and stash; the push stays with the lead', async () => {
    const h = host()
    for (const command of ['git checkout -b feature/x', 'git switch main', 'git stash', 'gh pr create --title t', 'glab mr create']) {
      expect((await gitGate(call('git', command), h.impl)).allow, command).toBe(true)
    }
    expect(reasonOf(await gitGate(call('git', 'git push origin feature'), h.impl))).toContain('The lead pushes')
    expect(reasonOf(await gitGate(call('git', 'gh pr merge 3'), h.impl))).toContain('person\'s call')
    expect(h.asked.branch).toEqual([])
  })

  test('cannot hide a git from the gate: opaque is denied for it too', async () => {
    const h = host({ branch: 'feature' })
    for (const command of ['P=push; git $P origin main', 'X="git push origin main"; eval "$X"', 'echo "git push origin main" | sh']) {
      expect(reasonOf(await gitGate(call('git', command), h.impl)), command).toContain('hidden')
    }
  })
})

describe('the agents that are not the lead, a developer or the git role', () => {
  test('the read-only roles and council seats may only read', async () => {
    const h = host({ branch: 'feature' })
    for (const actor of ['code-reader', 'docs-reader', 'architect', 'qa', 'councillor'] as const) {
      expect((await gitGate(call(actor, 'git log -3 && git diff'), h.impl)).allow, actor).toBe(true)
      expect(reasonOf(await gitGate(call(actor, 'git commit -am x'), h.impl)), actor).toContain('read-only')
      expect(reasonOf(await gitGate(call(actor, 'git push origin feature'), h.impl)), actor).toContain('read-only')
      expect(reasonOf(await gitGate(call(actor, 'gh pr merge 3'), h.impl)), actor).toContain('PR/MR work')
    }
  })
})

describe('a branch change fixes the branch only when && joins it', () => {
  const lead = (command: string, branch = 'main') => {
    const h = host({ branch })
    return gitGate(call('lead', command, { gitRole: false }), h.impl).then(outcome => ({ outcome, h }))
  }

  test('with ;, ||, a pipe or a newline the change may have failed and the branch is unknown', async () => {
    for (const command of [
      'git switch x || git push', 'git switch nonexistent; git push', 'git checkout -b andersonsilva/exists; git push -u origin HEAD',
      'git switch x\ngit push', 'git switch x | git push', 'git checkout -b x && git status; git push',
    ]) {
      const { outcome, h } = await lead(command, 'feature')
      expect(outcome.allow, command).toBe(false)
      expect(reasonOf(outcome), command).toContain('not joined')
      expect(h.asked.branch, command).toEqual([])
    }
  })

  test('with && it does, whatever stands between', async () => {
    const { outcome, h } = await lead('git checkout -b andersonsilva/x && git status && git push -u origin HEAD', 'main')
    expect(outcome.allow).toBe(true)
    expect(h.asked.branch).toEqual([])
    expect(reasonOf((await lead('git switch main && git status && git push', 'feature')).outcome)).toContain('current branch `main`')
  })

  test('the git role is held the same way for a commit after a failing switch', async () => {
    const h = host({ branch: 'main' })
    expect((await gitGate(call('git', 'git switch -c x; git commit -m y'), h.impl)).allow).toBe(false)
    expect((await gitGate(call('git', 'git switch -c x && git commit -m y'), h.impl)).allow).toBe(true)
  })
})

describe('where an agent\'s commands run', () => {
  const agents = [{ id: 'a' }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'b' }, { id: 'lonely', parentId: 'ghost' }]
  const book = (cwds: Record<string, string> = {}, unknown: string[] = []) => ({ cwds: new Map(Object.entries(cwds)), unknown: new Set(unknown) })

  test('the main loop is the session\'s; a subagent is its own spawn\'s cwd, else its parent\'s', () => {
    expect(cwdOfAgent(undefined, agents, book())).toBeUndefined()
    expect(cwdOfAgent('a', agents, book())).toBeUndefined()
    expect(cwdOfAgent('c', agents, book())).toBeUndefined()
    expect(cwdOfAgent('a', agents, book({ a: '/wt/a' }))).toBe('/wt/a')
    expect(cwdOfAgent('c', agents, book({ a: '/wt/a' }))).toBe('/wt/a')
    expect(cwdOfAgent('c', agents, book({ a: '/wt/a', b: '/wt/b' }))).toBe('/wt/b')
  })

  test('an isolated agent, or one nothing accounts for, is not knowable', () => {
    expect(cwdOfAgent('a', agents, book({}, ['a']))).toBeNull()
    expect(cwdOfAgent('c', agents, book({ a: '/wt/a' }, ['b']))).toBeNull()
    expect(cwdOfAgent('stranger', agents, book())).toBeNull()
    expect(cwdOfAgent('lonely', agents, book())).toBeNull()
  })
})
