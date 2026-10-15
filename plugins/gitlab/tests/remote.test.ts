import { expect, test } from 'claude-code/testing'
import { NO_REMOTE, currentBranch, locate, parseRemote, projectPath, sshHostname, type Git, type Ssh } from '../hooks/remote'

test('parseRemote reads SSH, scp-like and https remotes, with nested groups', () => {
  expect(parseRemote('git@gitlab.com:anderson-spider/tools.git')).toEqual({ host: 'gitlab.com', project: 'anderson-spider/tools', ssh: true })
  expect(parseRemote('ssh://git@GitLab.Example.com:2222/team/sub/app.git\n')).toEqual({ host: 'gitlab.example.com', project: 'team/sub/app', ssh: true })
  expect(parseRemote('https://gitlab.example.com/team/app')).toEqual({ host: 'gitlab.example.com', project: 'team/app' })
  expect(parseRemote('https://user:secret@gitlab.example.com:8443/team/app.git')).toEqual({ host: 'gitlab.example.com:8443', project: 'team/app' })
})

test('parseRemote refuses what is not a host and a group/project path', () => {
  for (const url of [
    '',
    '/srv/repos/app.git',
    'file:///srv/app.git',
    'git@gitlab.com:app.git',
    'https://gitlab.com/team/../app',
    'https://gitlab.com/team/%2e%2e/app',
    'https://evil.com#@gitlab.com/team/app',
    'git@bad_host:team/app.git',
  ]) {
    expect(parseRemote(url), url).toBeUndefined()
  }
})

const git =
  (answers: Record<string, { exitCode: number; stdout: string } | Error>): Git =>
  async (args) => {
    const a = answers[args.join(' ')] ?? { exitCode: 2, stdout: '' }
    if (a instanceof Error) throw a
    return a
  }

test('locate uses origin, else the first remote, and never echoes an unreadable remote URL', async () => {
  expect(await locate(git({ 'remote get-url origin': { exitCode: 0, stdout: 'git@gitlab.com:a/b.git\n' } }))).toEqual({ host: 'gitlab.com', project: 'a/b', ssh: true })
  expect(
    await locate(git({ remote: { exitCode: 0, stdout: 'upstream\nfork\n' }, 'remote get-url upstream': { exitCode: 0, stdout: 'https://h.io/a/b' } })),
  ).toEqual({ host: 'h.io', project: 'a/b' })
  expect(await locate(git({ 'remote get-url origin': new Error('not a repo') }))).toEqual({ error: NO_REMOTE })
  const odd = await locate(git({ 'remote get-url origin': { exitCode: 0, stdout: 'https://user:secret@h.io/app' } }))
  expect('error' in odd && odd.error).not.toContain('secret')
})

test('currentBranch is undefined on a detached HEAD or a failure', async () => {
  expect(await currentBranch(git({ 'rev-parse --abbrev-ref HEAD': { exitCode: 0, stdout: 'feature/x\n' } }))).toBe('feature/x')
  expect(await currentBranch(git({ 'rev-parse --abbrev-ref HEAD': { exitCode: 0, stdout: 'HEAD\n' } }))).toBeUndefined()
  expect(await currentBranch(git({}))).toBeUndefined()
})

test('projectPath takes a group/project path and refuses URLs, hosts and dot segments', () => {
  expect(projectPath(' group/sub-group/app/ ')).toBe('group/sub-group/app')
  for (const bad of ['app', 'https://gitlab.com/a/b', 'gitlab.com:a/b', 'git@h:a/b', 'a/../b', 'a/b?x=1', 'a b/c', '']) {
    expect(projectPath(bad), bad).toBeUndefined()
  }
})

test('sshHostname reads the real host of an SSH alias from ssh -G, and nothing when ssh fails or names no valid host', async () => {
  const ssh =
    (stdout: string, exitCode = 0): Ssh =>
    async (args) => (args.join(' ') === '-G work' ? { exitCode, stdout } : { exitCode: 255, stdout: '' })
  expect(await sshHostname(ssh('user git\nhostname GitLab.Example.com\nport 22\n'), 'work')).toBe('gitlab.example.com')
  expect(await sshHostname(ssh('hostname gitlab.example.com\n', 255), 'work')).toBeUndefined()
  expect(await sshHostname(ssh('hostname -oProxyCommand=x\n'), 'work')).toBeUndefined()
  expect(await sshHostname(ssh('hostname h\n'), '-oProxyCommand=x')).toBeUndefined()
  expect(await sshHostname(async () => Promise.reject(new Error('no ssh')), 'work')).toBeUndefined()
})
