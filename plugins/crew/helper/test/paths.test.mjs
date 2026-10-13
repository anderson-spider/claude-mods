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

test('the developer lane is the repository, resolved through links', () =>
  world(({ root, repo, options }) => {
    assert.deepEqual(resolveLane('developer', repo, options), { ok: true, cwd: repo })
    symlinkSync(repo, join(root, 'alias'))
    assert.deepEqual(resolveLane('developer', join(root, 'alias'), options), { ok: true, cwd: repo })
  }))

test('a repo that is missing, a file, relative or with .. is refused', () =>
  world(({ repo, options }) => {
    writeFileSync(join(repo, 'f'), 'x')

    for (const bad of [join(repo, 'nope'), join(repo, 'f'), 'repo', `${repo}/../repo`, '', undefined]) {
      assert.equal(resolveLane('developer', bad, options).ok, false, String(bad))
    }
  }))

test('the filesystem root, the home and its parents are refused; a directory under the home is fine', () =>
  world(({ root, home, repo, options }) => {
    for (const bad of ['/', home, root]) {
      assert.equal(resolveLane('developer', bad, options).ok, false, bad)
      assert.equal(resolveLane('architect', bad, options).ok, false, bad)
    }

    assert.equal(resolveLane('developer', repo, options).ok, true)
  }))

test('the Codex and Claude homes and the helper directory are refused, and so is a repo that contains one', () =>
  world(({ root, home, options }) => {
    mkdirSync(join(root, 'helper'))
    mkdirSync(join(home, '.codex', 'sub'))

    for (const bad of [join(home, '.codex'), join(home, '.codex', 'sub'), join(home, '.claude'), join(root, 'helper')]) {
      assert.equal(resolveLane('developer', bad, options).ok, false, bad)
    }
  }))

test('the architect lane is .crew, made when missing, and never a link or a file', () =>
  world(({ root, repo, options }) => {
    assert.deepEqual(resolveLane('architect', repo, options), { ok: true, cwd: join(repo, '.crew') })
    assert.deepEqual(resolveLane('architect', repo, options), { ok: true, cwd: join(repo, '.crew') })
    rmSync(join(repo, '.crew'), { recursive: true })
    symlinkSync(root, join(repo, '.crew'))

    const linked = resolveLane('architect', repo, options)
    assert.equal(linked.ok, false)
    assert.match(linked.message, /link/)
    rmSync(join(repo, '.crew'))
    writeFileSync(join(repo, '.crew'), 'file')
    assert.equal(resolveLane('architect', repo, options).ok, false)
  }))
