import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { resolveLane } from '../lib/paths.mjs'

/** A home and a repository under one temp root, removed afterwards. */
const world = run => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crew-paths-')))
  const home = join(root, 'home')
  const repo = join(home, 'work', 'repo')
  mkdirSync(repo, { recursive: true })
  mkdirSync(join(home, '.codex'))
  mkdirSync(join(home, '.claude'))
  try {
    return run({ root, home, repo, options: { home, forbidden: [join(home, '.codex'), join(home, '.claude'), join(root, 'helper')] } })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('the digger lane is the repository, resolved through links', () =>
  world(({ root, repo, options }) => {
    assert.deepEqual(resolveLane('digger', repo, options), { ok: true, cwd: repo })
    symlinkSync(repo, join(root, 'alias'))
    assert.deepEqual(resolveLane('digger', join(root, 'alias'), options), { ok: true, cwd: repo })
  }))

test('a repo that is missing, a file, relative or with .. is refused, and so is a role with no lane', () =>
  world(({ repo, options }) => {
    writeFileSync(join(repo, 'f'), 'x')

    for (const bad of [join(repo, 'nope'), join(repo, 'f'), 'repo', `${repo}/../repo`, '', undefined]) {
      assert.equal(resolveLane('digger', bad, options).ok, false, String(bad))
    }

    assert.equal(resolveLane('developer', repo, options).ok, false)
  }))

test('the filesystem root, the home and its parents are refused; a directory under the home is fine', () =>
  world(({ root, home, repo, options }) => {
    for (const bad of ['/', home, root]) {
      assert.equal(resolveLane('digger', bad, options).ok, false, bad)
    }

    assert.equal(resolveLane('digger', repo, options).ok, true)
  }))

test('the Codex and Claude homes and the helper directory are refused, and so is a repo that contains one', () =>
  world(({ root, home, options }) => {
    mkdirSync(join(root, 'helper'))
    mkdirSync(join(home, '.codex', 'sub'))

    for (const bad of [join(home, '.codex'), join(home, '.codex', 'sub'), join(home, '.claude'), join(root, 'helper')]) {
      assert.equal(resolveLane('digger', bad, options).ok, false, bad)
    }
  }))

test('a repository with a project Codex config, or under a directory that has one, is refused; the home\'s own is not a project', () =>
  world(({ home, repo, options }) => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'config.toml'), '')
    assert.equal(resolveLane('digger', repo, options).ok, true)

    mkdirSync(join(repo, '.codex'))
    writeFileSync(join(repo, '.codex', 'config.toml'), '[mcp_servers.x]\ncommand="/usr/bin/touch"\n')
    const refused = resolveLane('digger', repo, options)
    assert.equal(refused.ok, false)
    assert.match(refused.message, /outside the sandbox/)

    rmSync(join(repo, '.codex'), { recursive: true })
    mkdirSync(join(home, 'work', '.codex'))
    writeFileSync(join(home, 'work', '.codex', 'config.toml'), '')
    assert.equal(resolveLane('digger', repo, options).ok, false)
  }))
