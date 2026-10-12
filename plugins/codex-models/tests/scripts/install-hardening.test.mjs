// install.sh, uninstall.sh and install/cli.mjs on the files that hold the secret: mode 600, owner, symbolic links,
// behavesAs rows, a state ahead of the settings, and every X-Ccmproxy-Token value masked in dry runs.
// Same fakes as install.test.mjs: a temporary HOME, fake mise/launchctl/ccmproxy and an in-process proxy on two ports.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CLI = join(PLUGIN, 'install/cli.mjs')
const TOKEN = 'hardening-secret-AAAA1111'
const VERSION = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin/plugin.json'), 'utf8')).version

const servers = []
const ports = []

before(async () => {
  for (let i = 0; i < 2; i++) {
    const server = createServer((req, res) => {
      if (req.method === 'HEAD' && req.url === '/api/hello') return res.writeHead(200).end()
      if (req.url !== '/__ccmproxy/status') return res.writeHead(404).end()
      if (req.headers['x-ccmproxy-token'] === TOKEN) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ service: 'ccmproxy', version: VERSION, codexLogin: false, models: [] }))
      }
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'ccmproxy: missing or wrong X-Ccmproxy-Token' } }))
    })
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    servers.push(server)
    ports.push(server.address().port)
  }
})

after(() => servers.forEach(server => server.close()))

const DEFAULT_MODELS = [{ id: 'gpt-fake', label: 'GPT Fake', description: 'A fake Codex model' }]

function sandbox(models = DEFAULT_MODELS) {
  const root = mkdtempSync(join(tmpdir(), 'codex-models-hardening-'))
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(bin)
  const node = process.execPath
  const script = (name, body) => {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  writeFileSync(join(root, 'models.json'), JSON.stringify(models))
  writeFileSync(
    join(root, 'ccmproxy.mjs'),
    `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const args = process.argv.slice(2)
const config = join(process.env.CCMPROXY_HOME, 'config.json')
if (args[0] === 'config') {
  if (!existsSync(config)) {
    mkdirSync(dirname(config), { recursive: true })
    writeFileSync(config, JSON.stringify({ listen_http: '127.0.0.1:${ports[0]}', auth_token: '${TOKEN}' }), { mode: 0o600 })
  }
} else if (args[0] === 'env') {
  const c = JSON.parse(readFileSync(config, 'utf8'))
  console.log(JSON.stringify({ ANTHROPIC_BASE_URL: 'http://' + c.listen_http, ANTHROPIC_CUSTOM_HEADERS: 'X-Ccmproxy-Token: ' + c.auth_token, ENABLE_TOOL_SEARCH: 'true' }))
} else if (args[0] === 'models') {
  process.stdout.write(readFileSync(${JSON.stringify(join(root, 'models.json'))}, 'utf8'))
} else process.exit(3)
`,
  )
  writeFileSync(join(root, 'ccmproxy'), `#!/bin/sh\nexec "${node}" "${join(root, 'ccmproxy.mjs')}" "$@"\n`)
  chmodSync(join(root, 'ccmproxy'), 0o755)
  script(
    'mise',
    `#!/bin/sh
echo "mise $*" >>"${join(root, 'calls.log')}"
case "$1" in
  where) echo /fake/install; exit 0 ;;
  exec)
    shift 2; [ "$1" = "--" ] && shift
    tool=$1; shift
    if [ "$tool" = env ]; then
      while [ $# -gt 0 ]; do case "$1" in *=*) export "$1"; shift ;; *) break ;; esac; done
      tool=$1; shift
    fi
    if [ "$tool" = node ]; then exec "${node}" $NODE_EXTRA "$@"; fi
    if [ "$tool" = go ]; then
      while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { cp "${join(root, 'ccmproxy')}" "$2"; chmod +x "$2"; exit 0; }; shift; done
      exit 4
    fi
    exit 5 ;;
esac
exit 6
`,
  )
  script('launchctl', `#!/bin/sh\necho "launchctl $*" >>"${join(root, 'calls.log')}"\n[ "$1" = print ] && exit 1\nexit 0\n`)

  const env = extra => ({ PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: root, ...extra })
  // umask 022, the common default, so a file left at the umask's mode would be 0644.
  const run = (file, args = [], extra = {}) =>
    new Promise(done => {
      execFile('/bin/sh', ['-c', 'umask 022; exec /bin/sh "$@"', 'sh', join(PLUGIN, file), ...args], { env: env(extra), timeout: 30000 }, (error, stdout, stderr) =>
        done({ code: error ? error.code ?? 1 : 0, stdout, stderr }),
      )
    })
  const cli = (args, extra = {}) =>
    new Promise(done => {
      const pre = extra.NODE_EXTRA ? extra.NODE_EXTRA.split(' ') : []
      execFile(node, [...pre, CLI, ...args], { env: env(extra), timeout: 30000 }, (error, stdout, stderr) => done({ code: error ? 1 : 0, stdout, stderr }))
    })
  const calls = () => (existsSync(join(root, 'calls.log')) ? readFileSync(join(root, 'calls.log'), 'utf8') : '')
  const claude = join(home, '.claude')
  const settingsFile = join(claude, 'settings.json')
  const state = join(claude, 'codex-models/settings-state.json')
  const config = join(claude, 'codex-models/home/config.json')
  return { root, home, claude, run, cli, calls, settingsFile, state, config, cleanup: () => { chmodSync(claude, 0o755); rmSync(root, { recursive: true, force: true }) } }
}

const modeOf = path => statSync(path).mode & 0o777
const json = value => `${JSON.stringify(value, null, 2)}\n`
const backupsIn = dir => readdirSync(dir).filter(name => name.includes('.bak-codex-models-'))

/** A preload that makes statSync and lstatSync report uid 0 for paths matching FOREIGN_RE (chown needs root). */
function foreignPreload(root) {
  const file = join(root, 'foreign.mjs')
  writeFileSync(
    file,
    `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const re = new RegExp(process.env.FOREIGN_RE)
const foreign = original => (path, ...rest) => {
  const s = original(path, ...rest)
  if (s && re.test(String(path))) return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { uid: 0 })
  return s
}
fs.statSync = foreign(fs.statSync)
fs.lstatSync = foreign(fs.lstatSync)
syncBuiltinESMExports()
`,
  )
  return `--import ${file}`
}

const ORIGINAL = {
  env: { USE_BUILTIN_RIPGREP: '0', ANTHROPIC_CUSTOM_HEADERS: 'X-Team: blue', ENABLE_TOOL_SEARCH: 'false' },
  modelPicker: { options: [{ model: 'claude-opus-4-8', label: 'Opus' }] },
  theme: 'dark',
}

// mode 600

test('fresh install under umask 022: settings, state and backup are 0600; a no-change reinstall from 0644 and uninstall end 0600', async () => {
  const box = sandbox()
  try {
    writeFileSync(box.settingsFile, json(ORIGINAL))
    chmodSync(box.settingsFile, 0o644)
    const out = await box.run('install.sh')
    assert.equal(out.code, 0, out.stderr)
    assert.equal(modeOf(box.settingsFile), 0o600)
    assert.equal(modeOf(box.state), 0o600)
    const backups = backupsIn(box.claude)
    assert.equal(backups.length, 1)
    for (const name of backups) assert.equal(modeOf(join(box.claude, name)), 0o600, name)

    chmodSync(box.settingsFile, 0o644)
    chmodSync(box.state, 0o644)
    chmodSync(join(box.claude, backups[0]), 0o644)
    const once = readFileSync(box.settingsFile, 'utf8')
    const again = await box.run('install.sh')
    assert.equal(again.code, 0, again.stderr)
    assert.match(again.stdout, /already holds the codex-models entries/)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), once)
    assert.equal(modeOf(box.settingsFile), 0o600)
    assert.equal(modeOf(box.state), 0o600)
    assert.equal(modeOf(join(box.claude, backups[0])), 0o600, 'older backup restricted on a no-change reinstall')

    chmodSync(box.settingsFile, 0o644)
    const removed = await box.run('uninstall.sh')
    assert.equal(removed.code, 0, removed.stderr)
    assert.deepEqual(JSON.parse(readFileSync(box.settingsFile, 'utf8')), ORIGINAL)
    assert.equal(modeOf(box.settingsFile), 0o600)
    for (const name of backupsIn(box.claude)) assert.equal(modeOf(join(box.claude, name)), 0o600, name)
    assert.equal(backupsIn(box.claude).length, 2)
    assert.equal(readdirSync(box.claude).filter(name => name.endsWith('.tmp')).length, 0, 'no temp file left')
  } finally {
    box.cleanup()
  }
})

test('a symlinked settings.json stays a link; its target and backups beside the target end 0600', async () => {
  const box = sandbox()
  try {
    const dots = join(box.root, 'dotfiles')
    mkdirSync(dots)
    const real = join(dots, 'settings.json')
    writeFileSync(real, json(ORIGINAL))
    chmodSync(real, 0o644)
    symlinkSync(real, box.settingsFile)

    const out = await box.run('install.sh')
    assert.equal(out.code, 0, out.stderr)
    assert.ok(lstatSync(box.settingsFile).isSymbolicLink(), 'still a link after install')
    assert.equal(modeOf(real), 0o600)
    assert.equal(JSON.parse(readFileSync(real, 'utf8')).env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${ports[0]}`)
    assert.equal(backupsIn(dots).length, 1)
    for (const name of backupsIn(dots)) assert.equal(modeOf(join(dots, name)), 0o600)

    chmodSync(real, 0o644)
    assert.equal((await box.run('install.sh')).code, 0)
    assert.ok(lstatSync(box.settingsFile).isSymbolicLink(), 'still a link after a no-change reinstall')
    assert.equal(modeOf(real), 0o600)

    const removed = await box.run('uninstall.sh')
    assert.equal(removed.code, 0, removed.stderr)
    assert.ok(lstatSync(box.settingsFile).isSymbolicLink(), 'still a link after uninstall')
    assert.deepEqual(JSON.parse(readFileSync(real, 'utf8')), ORIGINAL)
    assert.equal(modeOf(real), 0o600)
    for (const name of backupsIn(dots)) assert.equal(modeOf(join(dots, name)), 0o600)
  } finally {
    box.cleanup()
  }
})

test('a settings.json that lands on a root-owned file (/dev/null) is refused in precheck, before anything runs', async () => {
  const box = sandbox()
  try {
    symlinkSync('/dev/null', box.settingsFile)
    const out = await box.run('install.sh')
    assert.notEqual(out.code, 0)
    assert.match(out.stderr, /\/dev\/null belongs to another user \(uid 0\)/)
    assert.match(out.stderr, /nothing was changed/)
    assert.ok(!existsSync(join(box.claude, 'codex-models')), 'no install home')
    assert.ok(!existsSync(join(box.home, 'Library')), 'no plist')
    assert.doesNotMatch(box.calls(), /launchctl|exec go/)
    assert.deepEqual(backupsIn(box.claude), [])

    const check = await box.run('install.sh', ['--check'])
    assert.notEqual(check.code, 0)
    assert.match(check.stderr, /belongs to another user/)
  } finally {
    box.cleanup()
  }
})

test('merge refuses a foreign settings file before the state write, and a foreign state file with nothing changed', async () => {
  const box = sandbox()
  try {
    const envFile = join(box.root, 'env.json')
    const modelsFile = join(box.root, 'models.json')
    writeFileSync(envFile, JSON.stringify({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${ports[0]}`, ANTHROPIC_CUSTOM_HEADERS: `X-Ccmproxy-Token: ${TOKEN}`, ENABLE_TOOL_SEARCH: 'true' }))
    const text = json(ORIGINAL)
    writeFileSync(box.settingsFile, text)
    chmodSync(box.settingsFile, 0o644)
    mkdirSync(dirname(box.state), { recursive: true })
    const NODE_EXTRA = foreignPreload(box.root)
    const args = ['merge', '--settings', box.settingsFile, '--state', box.state, '--env', envFile, '--models', modelsFile]

    // Settings foreign (a race after precheck): refused before the state is written.
    const a = await box.cli(args, { NODE_EXTRA, FOREIGN_RE: 'settings\\.json$' })
    assert.equal(a.code, 1)
    assert.match(a.stderr, /settings\.json belongs to another user \(uid 0\)/)
    assert.ok(!existsSync(box.state), 'no state written')
    assert.equal(readFileSync(box.settingsFile, 'utf8'), text)
    assert.equal(modeOf(box.settingsFile), 0o644, 'mode untouched')
    assert.deepEqual(backupsIn(box.claude), [])

    // State foreign: refused before any write.
    const priorState = json({ v: 1, junk: true })
    writeFileSync(box.state, priorState)
    const b = await box.cli(args, { NODE_EXTRA, FOREIGN_RE: 'settings-state\\.json$' })
    assert.equal(b.code, 1)
    assert.match(b.stderr, /settings-state\.json belongs to another user/)
    assert.equal(readFileSync(box.state, 'utf8'), priorState)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), text)
    assert.deepEqual(backupsIn(box.claude), [])
    rmSync(box.state)

    // Unmerge on a foreign settings file with our entries: refused, nothing changed, no backup.
    const installed = await box.cli(args)
    assert.equal(installed.code, 0, installed.stderr)
    const now = readFileSync(box.settingsFile, 'utf8')
    for (const name of backupsIn(box.claude)) rmSync(join(box.claude, name))
    const c = await box.cli(['unmerge', '--settings', box.settingsFile, '--state', box.state], { NODE_EXTRA, FOREIGN_RE: 'settings\\.json$' })
    assert.equal(c.code, 1)
    assert.match(c.stderr, /belongs to another user/)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), now)
    assert.ok(existsSync(box.state))
    assert.deepEqual(backupsIn(box.claude), [])
  } finally {
    box.cleanup()
  }
})

test('an older backup that is not the user\'s own is left at its mode', async () => {
  const box = sandbox()
  try {
    writeFileSync(box.settingsFile, json(ORIGINAL))
    const theirs = join(box.claude, 'settings.json.bak-codex-models-20250101-000000')
    const mine = join(box.claude, 'settings.json.bak-codex-models-20250101-000001')
    writeFileSync(theirs, '{}\n')
    writeFileSync(mine, '{}\n')
    chmodSync(theirs, 0o644)
    chmodSync(mine, 0o644)
    const envFile = join(box.root, 'env.json')
    writeFileSync(envFile, JSON.stringify({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${ports[0]}`, ANTHROPIC_CUSTOM_HEADERS: `X-Ccmproxy-Token: ${TOKEN}`, ENABLE_TOOL_SEARCH: 'true' }))
    mkdirSync(dirname(box.state), { recursive: true })
    const out = await box.cli(['merge', '--settings', box.settingsFile, '--state', box.state, '--env', envFile, '--models', join(box.root, 'models.json')], {
      NODE_EXTRA: foreignPreload(box.root),
      FOREIGN_RE: '000000$',
    })
    assert.equal(out.code, 0, out.stderr)
    assert.equal(modeOf(theirs), 0o644)
    assert.equal(modeOf(mine), 0o600)
  } finally {
    box.cleanup()
  }
})

/** What an install left on disk that a refused run must not touch. */
function snapshot(box) {
  const target = join(box.claude, 'codex-models')
  const plist = join(box.home, 'Library/LaunchAgents/com.anderson-spider.codex-models.plist')
  const id = path => {
    const s = lstatSync(path)
    return `${s.ino}:${s.mtimeMs}:${s.mode}`
  }
  return {
    settings: readFileSync(box.settingsFile, 'utf8'),
    state: lstatSync(box.state).isSymbolicLink() ? 'link' : readFileSync(box.state, 'utf8'),
    files: ['bin/ccmproxy', 'install/cli.mjs', 'install.sh', 'uninstall.sh', 'ccmproxy', 'VERSION'].map(name => id(join(target, name))),
    plist: id(plist),
    backups: backupsIn(box.claude).sort(),
  }
}

test('after a real install, a foreign state file stops install (also --dry-run, --check) and uninstall (also --dry-run, --purge) before any build, copy or launchctl call', async () => {
  const box = sandbox()
  try {
    writeFileSync(box.settingsFile, json(ORIGINAL))
    assert.equal((await box.run('install.sh')).code, 0)
    const saved = readFileSync(box.state, 'utf8')
    const NODE_EXTRA = foreignPreload(box.root)

    for (const how of ['uid 0', '/dev/null']) {
      const extra = how === 'uid 0' ? { NODE_EXTRA, FOREIGN_RE: 'settings-state\\.json$' } : {}
      if (how === '/dev/null') {
        rmSync(box.state)
        symlinkSync('/dev/null', box.state)
      }
      const before = snapshot(box)
      for (const [file, args] of [
        ['install.sh', []],
        ['install.sh', ['--dry-run']],
        ['install.sh', ['--check']],
        ['uninstall.sh', []],
        ['uninstall.sh', ['--dry-run']],
        ['uninstall.sh', ['--purge']],
      ]) {
        const mark = box.calls().length
        const out = await box.run(file, args, extra)
        const label = `${how}: ${file} ${args.join(' ')}`
        assert.notEqual(out.code, 0, label)
        assert.match(out.stderr, /belongs to another user \(uid 0\)/, label)
        assert.doesNotMatch(box.calls().slice(mark), /launchctl|exec go/, label)
        assert.deepEqual(snapshot(box), before, label)
        assert.doesNotMatch(out.stdout + out.stderr, new RegExp(TOKEN), label)
      }
    }

    // Once the state is the user's again, uninstall works and restores the original.
    rmSync(box.state)
    writeFileSync(box.state, saved, { mode: 0o600 })
    const removed = await box.run('uninstall.sh')
    assert.equal(removed.code, 0, removed.stderr)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), json(ORIGINAL))
  } finally {
    box.cleanup()
  }
})

test('--no-settings skips the settings and the state, so a foreign state file neither stops it nor is touched', async () => {
  const box = sandbox()
  try {
    mkdirSync(dirname(box.state), { recursive: true })
    writeFileSync(box.state, '{"v":1}\n')
    chmodSync(box.state, 0o644)
    const out = await box.run('install.sh', ['--no-settings'], { NODE_EXTRA: foreignPreload(box.root), FOREIGN_RE: 'settings-state\\.json$' })
    assert.equal(out.code, 0, out.stderr)
    assert.equal(readFileSync(box.state, 'utf8'), '{"v":1}\n')
    assert.equal(modeOf(box.state), 0o644)
    assert.ok(!existsSync(box.settingsFile))
  } finally {
    box.cleanup()
  }
})

test('a dangling link and a link to an own file under the backup name are left alone, and install still runs', async () => {
  const box = sandbox()
  try {
    writeFileSync(box.settingsFile, json(ORIGINAL))
    const own = join(box.claude, 'notes.txt')
    writeFileSync(own, 'x')
    chmodSync(own, 0o644)
    const toOwn = join(box.claude, 'settings.json.bak-codex-models-to-own')
    const dangling = join(box.claude, 'settings.json.bak-codex-models-dangling')
    symlinkSync(own, toOwn)
    symlinkSync(join(box.root, 'missing'), dangling)

    const out = await box.run('install.sh')
    assert.equal(out.code, 0, out.stderr)
    assert.equal(modeOf(own), 0o644, 'a link is never followed')
    assert.ok(lstatSync(toOwn).isSymbolicLink() && lstatSync(dangling).isSymbolicLink())

    chmodSync(box.settingsFile, 0o644)
    assert.equal((await box.run('install.sh')).code, 0, 'no-change reinstall')
    const removed = await box.run('uninstall.sh')
    assert.equal(removed.code, 0, removed.stderr)
    assert.equal(modeOf(own), 0o644)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), json(ORIGINAL))
  } finally {
    box.cleanup()
  }
})

// behavesAs

test('behavesAs reaches the picker rows through install.sh only when a non-empty string, and uninstall restores the original', async () => {
  const models = [
    { id: 'gpt-a', label: 'A', description: 'alpha', behavesAs: 'claude-opus-4-8' },
    { id: 'gpt-b', label: 'B', behavesAs: '' },
    { id: 'gpt-c', label: 'C', behavesAs: '   ' },
    { id: 'gpt-d', label: 'D', behavesAs: 42 },
    { id: 'gpt-e', label: 'E', behavesAs: null },
    { id: 'gpt-f', label: 'F', behavesAs: ['claude-opus-4-8'] },
    { id: 'gpt-g', label: 'G' },
  ]
  const box = sandbox(models)
  try {
    writeFileSync(box.settingsFile, json(ORIGINAL))
    const out = await box.run('install.sh')
    assert.equal(out.code, 0, out.stderr)
    const rows = JSON.parse(readFileSync(box.settingsFile, 'utf8')).modelPicker.options
    assert.deepEqual(rows[0], ORIGINAL.modelPicker.options[0])
    const ours = rows.slice(1)
    assert.equal(ours.length, 7)
    for (const row of ours) assert.ok(row.description.endsWith('(codex-models)'), row.model)
    assert.deepEqual(ours[0], { model: 'gpt-a', label: 'A', description: 'alpha (codex-models)', behavesAs: 'claude-opus-4-8' })
    for (const row of ours.slice(1)) assert.ok(!('behavesAs' in row), `${row.model} has no behavesAs`)

    const removed = await box.run('uninstall.sh')
    assert.equal(removed.code, 0, removed.stderr)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), json(ORIGINAL))
  } finally {
    box.cleanup()
  }
})

// state/settings divergence

test('install on A, config moves to B, an install that writes the state but not the settings is still undone; a reinstall works', async () => {
  const box = sandbox()
  try {
    writeFileSync(box.settingsFile, json(ORIGINAL))
    assert.equal((await box.run('install.sh')).code, 0)
    const onA = readFileSync(box.settingsFile, 'utf8')
    assert.match(onA, new RegExp(`127\\.0\\.0\\.1:${ports[0]}`))

    // The config now listens on B (as a regenerated port would).
    const cfg = JSON.parse(readFileSync(box.config, 'utf8'))
    writeFileSync(box.config, JSON.stringify({ ...cfg, listen_http: `127.0.0.1:${ports[1]}` }))

    // ~/.claude read-only: the state (in codex-models/) is written, the backup/settings write beside settings.json fails.
    chmodSync(box.claude, 0o555)
    const stopped = await box.run('install.sh')
    chmodSync(box.claude, 0o755)
    assert.notEqual(stopped.code, 0)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), onA, 'settings still on A')
    const state = JSON.parse(readFileSync(box.state, 'utf8'))
    assert.deepEqual(state.baseUrls, [`http://127.0.0.1:${ports[1]}`, `http://127.0.0.1:${ports[0]}`])
    assert.equal(state.baseUrl, `http://127.0.0.1:${ports[1]}`)
    assert.doesNotMatch(JSON.stringify(state), new RegExp(TOKEN))
    assert.equal(modeOf(box.state), 0o600)

    // Uninstall from here restores the original exactly.
    const saved = readFileSync(box.state, 'utf8')
    const removed = await box.run('uninstall.sh')
    assert.equal(removed.code, 0, removed.stderr)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), json(ORIGINAL))

    // Same divergence, then a reinstall instead: it moves to B and uninstall still restores the original.
    writeFileSync(box.settingsFile, onA)
    writeFileSync(box.state, saved)
    const again = await box.run('install.sh')
    assert.equal(again.code, 0, again.stderr)
    assert.equal(JSON.parse(readFileSync(box.settingsFile, 'utf8')).env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${ports[1]}`)
    assert.equal((await box.run('uninstall.sh')).code, 0)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), json(ORIGINAL))
  } finally {
    box.cleanup()
  }
})

test('an older state holding only baseUrl still uninstalls and reinstalls', async () => {
  const box = sandbox()
  try {
    writeFileSync(box.settingsFile, json(ORIGINAL))
    assert.equal((await box.run('install.sh')).code, 0)
    const { baseUrls, ...older } = JSON.parse(readFileSync(box.state, 'utf8'))
    assert.ok(Array.isArray(baseUrls))
    writeFileSync(box.state, json(older))

    const re = await box.run('install.sh')
    assert.equal(re.code, 0, re.stderr)
    assert.equal(JSON.parse(readFileSync(box.state, 'utf8')).envCreated, false)

    writeFileSync(box.state, json(older))
    const removed = await box.run('uninstall.sh')
    assert.equal(removed.code, 0, removed.stderr)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), json(ORIGINAL))
  } finally {
    box.cleanup()
  }
})

test('uninstall takes out an unrecorded loopback base URL with our header and leaves foreign ones', async () => {
  const box = sandbox()
  try {
    const unmerge = () => box.cli(['unmerge', '--settings', box.settingsFile, '--state', box.state])
    const cases = [
      // [settings env, expected env after]
      [{ ANTHROPIC_BASE_URL: 'http://127.0.0.1:1111', ANTHROPIC_CUSTOM_HEADERS: 'x-CCMPROXY-token: zz' }, {}],
      [{ ANTHROPIC_BASE_URL: 'http://localhost:2222/', ANTHROPIC_CUSTOM_HEADERS: 'X-Team: blue\nX-Ccmproxy-Token: zz' }, { ANTHROPIC_CUSTOM_HEADERS: 'X-Team: blue' }],
      [{ ANTHROPIC_BASE_URL: 'http://[::1]:3333', ANTHROPIC_CUSTOM_HEADERS: 'X-Ccmproxy-Token: zz' }, {}],
      [{ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4444' }, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4444' }],
      [{ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4444', ANTHROPIC_CUSTOM_HEADERS: 'X-Team: blue' }, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4444', ANTHROPIC_CUSTOM_HEADERS: 'X-Team: blue' }],
      [{ ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_CUSTOM_HEADERS: 'X-Ccmproxy-Token: zz' }, { ANTHROPIC_BASE_URL: 'https://gw.example.com' }],
      [{ ANTHROPIC_BASE_URL: 'http://10.0.0.5:1111', ANTHROPIC_CUSTOM_HEADERS: 'X-Ccmproxy-Token: zz' }, { ANTHROPIC_BASE_URL: 'http://10.0.0.5:1111' }],
      [{ ANTHROPIC_BASE_URL: 'http://127.0.0.1:1111/v1', ANTHROPIC_CUSTOM_HEADERS: 'X-Ccmproxy-Token: zz' }, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1111/v1' }],
    ]
    for (const withState of [false, true]) {
      for (const [envBefore, envAfter] of cases) {
        writeFileSync(box.settingsFile, json({ env: envBefore, theme: 'x' }))
        if (withState) {
          mkdirSync(dirname(box.state), { recursive: true })
          // A state recording only some other port.
          writeFileSync(box.state, json({ v: 1, baseUrl: 'http://127.0.0.1:9', baseUrls: ['http://127.0.0.1:9'], envCreated: false, headersExisted: false, toolSearch: { present: false }, pickerCreated: true, optionsCreated: true, fileCreated: false }))
        } else if (existsSync(box.state)) rmSync(box.state)
        const out = await unmerge()
        assert.equal(out.code, 0, out.stderr)
        assert.deepEqual(JSON.parse(readFileSync(box.settingsFile, 'utf8')).env, envAfter, `${withState ? 'state' : 'no state'}: ${JSON.stringify(envBefore)}`)
        assert.doesNotMatch(out.stdout + out.stderr, /zz/)
      }
    }
  } finally {
    box.cleanup()
  }
})

// dry-run masking

const OLD1 = 'old-secret-BBBB2222'
const OLD2 = 'old-secret-CCCC3333'
const OLD3 = 'old-secret-DDDD4444'

/** Every file under `dir` whose bytes hold one of `secrets`, skipping the given paths. */
function filesHolding(dir, secrets, skip = []) {
  const found = []
  const walk = d => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (skip.includes(p)) continue
      const s = lstatSync(p)
      if (s.isDirectory()) walk(p)
      else if (s.isFile()) {
        const text = readFileSync(p, 'utf8')
        if (secrets.some(secret => text.includes(secret))) found.push(p)
      }
    }
  }
  walk(dir)
  return found
}

test('install --dry-run masks every token line, any case and spacing, old and new, and leaves nothing behind', async () => {
  const box = sandbox()
  try {
    const headers = `X-Team: blue\r\nX-CCMPROXY-TOKEN:${OLD1}\n  x-ccmproxy-token :  ${OLD2} \nX-Ccmproxy-Token: ${OLD3}`
    const text = json({ env: { ANTHROPIC_CUSTOM_HEADERS: headers }, theme: 'dark' })
    writeFileSync(box.settingsFile, text)
    const out = await box.run('install.sh', ['--dry-run'])
    assert.equal(out.code, 0, out.stderr)
    const all = out.stdout + out.stderr
    for (const secret of [OLD1, OLD2, OLD3, TOKEN]) assert.ok(!all.includes(secret), `${secret} printed`)
    assert.match(out.stdout, /^-.*X-CCMPROXY-TOKEN: <secret>/m)
    assert.match(out.stdout, /^-.*x-ccmproxy-token : <secret>/m)
    assert.match(out.stdout, /^\+.*X-Ccmproxy-Token: <secret>/m)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), text)
    assert.deepEqual(readdirSync(box.claude), ['settings.json'])
    assert.deepEqual(filesHolding(box.root, [OLD1, OLD2, OLD3, TOKEN], [box.settingsFile, join(box.root, "ccmproxy.mjs")]), [], 'no file under TMPDIR or HOME holds a secret')
  } finally {
    box.cleanup()
  }
})

test('after a real install, both dry runs hide the live secret and an extra old token', async () => {
  const box = sandbox()
  try {
    writeFileSync(box.settingsFile, json(ORIGINAL))
    assert.equal((await box.run('install.sh')).code, 0)
    const s = JSON.parse(readFileSync(box.settingsFile, 'utf8'))
    s.env.ANTHROPIC_CUSTOM_HEADERS = `x-ccmproxy-token: ${OLD1}\n${s.env.ANTHROPIC_CUSTOM_HEADERS}`
    writeFileSync(box.settingsFile, json(s))
    const before = readFileSync(box.settingsFile, 'utf8')

    const dryInstall = await box.run('install.sh', ['--dry-run'])
    assert.equal(dryInstall.code, 0, dryInstall.stderr)
    const dryUninstall = await box.run('uninstall.sh', ['--dry-run'])
    assert.equal(dryUninstall.code, 0, dryUninstall.stderr)
    for (const out of [dryInstall, dryUninstall]) {
      const all = out.stdout + out.stderr
      for (const secret of [OLD1, TOKEN]) assert.ok(!all.includes(secret), `${secret} printed`)
      assert.match(out.stdout, /x-ccmproxy-token: <secret>/)
    }
    assert.match(dryUninstall.stdout, /^-.*X-Ccmproxy-Token: <secret>/m)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), before)
    assert.deepEqual(filesHolding(box.root, [OLD1, TOKEN], [box.settingsFile, box.config, join(box.root, "ccmproxy.mjs"), ...backupsIn(box.claude).map(n => join(box.claude, n))]), [])
  } finally {
    box.cleanup()
  }
})

test('uninstall --dry-run masks a token in a file install did not write (no state), and a file that would be removed', async () => {
  const box = sandbox()
  try {
    writeFileSync(box.settingsFile, json({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_CUSTOM_HEADERS: `X-CCMPROXY-TOKEN: ${OLD1}\nx-ccmproxy-token:${OLD2}` } }))
    const dry = await box.run('uninstall.sh', ['--dry-run'])
    assert.equal(dry.code, 0, dry.stderr)
    for (const secret of [OLD1, OLD2]) assert.ok(!(dry.stdout + dry.stderr).includes(secret), `${secret} printed`)

    rmSync(box.settingsFile)
    assert.equal((await box.run('install.sh')).code, 0)
    const gone = await box.run('uninstall.sh', ['--dry-run'])
    assert.equal(gone.code, 0, gone.stderr)
    assert.ok(!(gone.stdout + gone.stderr).includes(TOKEN))
    assert.match(gone.stdout, /^-.*X-Ccmproxy-Token: <secret>/m)
  } finally {
    box.cleanup()
  }
})
