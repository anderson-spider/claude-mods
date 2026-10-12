// install.sh, uninstall.sh and install/cli.mjs: private atomic writes, symbolic links,
// behavesAs rows, failure ordering and every token value masked in install dry runs.
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
  /** Inject filesystem failures into child Node processes, never the test runner. */
  const preload = body => {
    const file = join(root, 'io-preload.mjs')
    writeFileSync(file, `import fs from 'node:fs'\nimport { syncBuiltinESMExports } from 'node:module'\n${body}\nsyncBuiltinESMExports()\n`)
    return { NODE_EXTRA: `--import ${file}` }
  }
  const calls = () => (existsSync(join(root, 'calls.log')) ? readFileSync(join(root, 'calls.log'), 'utf8') : '')
  const claude = join(home, '.claude')
  const settingsFile = join(claude, 'settings.json')
  const config = join(claude, 'codex-models/home/config.json')
  return { root, home, claude, run, cli, preload, calls, settingsFile, config, cleanup: () => { chmodSync(claude, 0o755); rmSync(root, { recursive: true, force: true }) } }
}

const modeOf = path => statSync(path).mode & 0o777

const json = value => `${JSON.stringify(value, null, 2)}\n`
const backupsIn = dir => readdirSync(dir).filter(name => name.includes('.bak-codex-models-'))

const ORIGINAL = {
  env: { USE_BUILTIN_RIPGREP: '0', ANTHROPIC_CUSTOM_HEADERS: 'X-Team: blue', ENABLE_TOOL_SEARCH: 'false' },
  modelPicker: { options: [{ model: 'claude-opus-4-8', label: 'Opus' }] },
  theme: 'dark',
}

const CLEANED = { ...ORIGINAL, env: { USE_BUILTIN_RIPGREP: '0', ANTHROPIC_CUSTOM_HEADERS: 'X-Team: blue' } }

test('precheck mirrors Go listen_http matching across capitalization and duplicate keys', async () => {
  const box = sandbox()
  try {
    mkdirSync(dirname(box.config), { recursive: true })
    const args = ['precheck', '--settings', box.settingsFile, '--config', box.config]
    const cases = [
      ['{"LISTEN_HTTP":"127.0.0.1:34567"}', '127.0.0.1:34567'],
      ['{"Listen_Http":"127.0.0.1:34567"}', '127.0.0.1:34567'],
      ['{"listen_http":"127.0.0.1:1111","LISTEN_HTTP":"127.0.0.1:34567"}', '127.0.0.1:34567'],
      ['{"LISTEN_HTTP":"127.0.0.1:1111","listen_http":"127.0.0.1:34567"}', '127.0.0.1:34567'],
      ['{"LISTEN_HTTP":"127.0.0.1:1111","listen_http":"127.0.0.1:2222","LISTEN_HTTP":"127.0.0.1:34567"}', '127.0.0.1:34567'],
      ['{"listen_http":"127.0.0.1:1111","LISTEN_HTTP":"127.0.0.1:2222","listen_http":"127.0.0.1:34567"}', '127.0.0.1:34567'],
      ['{"listen_http":"127.0.0.1:34567","LISTEN_HTTP":null}', '127.0.0.1:34567'],
      ['{"liſten_http":"127.0.0.1:34567"}', '127.0.0.1:34567'],
      [String.raw`{"listen_http":"127.0.0.1:34567"}`, '127.0.0.1:34567'],
      ['{"listen_http":"127.0.0.1:34567","unknown":{"LISTEN_HTTP":"127.0.0.1:9999"},"rows":[{"listen_http":"127.0.0.1:9999"}],"note":"listen_http"}', '127.0.0.1:34567'],
    ]
    for (const [config, listen] of cases) {
      writeFileSync(box.config, config)
      const current = json({ env: { ANTHROPIC_BASE_URL: `http://${listen}`, ANTHROPIC_CUSTOM_HEADERS: `X-Ccmproxy-Token: ${TOKEN}` } })
      writeFileSync(box.settingsFile, current)
      const accepted = await box.cli(args)
      assert.equal(accepted.code, 0, `${config}: ${accepted.stderr}`)
      assert.equal(readFileSync(box.settingsFile, 'utf8'), current)
      assert.deepEqual(backupsIn(box.claude), [])
      assert.equal(box.calls(), '')

      writeFileSync(box.settingsFile, json({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:45678', ANTHROPIC_CUSTOM_HEADERS: `X-Ccmproxy-Token: ${TOKEN}` } }))
      const refused = await box.cli(args)
      assert.equal(refused.code, 1, config)
      assert.match(refused.stderr, /uninstall first/)
      assert.doesNotMatch(refused.stdout + refused.stderr, new RegExp(TOKEN))
    }
    for (const config of ['{"LISTEN_HTTP":42}', '{"listen_http":false,"LISTEN_HTTP":"127.0.0.1:34567"}']) {
      writeFileSync(box.config, config)
      const refused = await box.cli(args)
      assert.equal(refused.code, 1, config)
      assert.match(refused.stderr, /listen_http that is not a string/)
    }
  } finally {
    box.cleanup()
  }
})

// mode 600

test('fresh install under umask 022: settings and backup are 0600; a no-change reinstall from 0644 and uninstall end 0600', async () => {
  const box = sandbox()
  try {
    writeFileSync(box.settingsFile, json(ORIGINAL))
    chmodSync(box.settingsFile, 0o644)
    const out = await box.run('install.sh')
    assert.equal(out.code, 0, out.stderr)
    assert.equal(modeOf(box.settingsFile), 0o600)
    const backups = backupsIn(box.claude)
    assert.equal(backups.length, 1)
    for (const name of backups) assert.equal(modeOf(join(box.claude, name)), 0o600, name)

    chmodSync(box.settingsFile, 0o644)
    chmodSync(join(box.claude, backups[0]), 0o644)
    const once = readFileSync(box.settingsFile, 'utf8')
    const again = await box.run('install.sh')
    assert.equal(again.code, 0, again.stderr)
    assert.match(again.stdout, /already holds the codex-models entries/)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), once)
    assert.equal(modeOf(box.settingsFile), 0o600)
    assert.equal(modeOf(join(box.claude, backups[0])), 0o600, 'older backup restricted on a no-change reinstall')

    chmodSync(box.settingsFile, 0o644)
    const removed = await box.run('uninstall.sh')
    assert.equal(removed.code, 0, removed.stderr)
    assert.deepEqual(JSON.parse(readFileSync(box.settingsFile, 'utf8')), CLEANED)
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
    assert.deepEqual(JSON.parse(readFileSync(real, 'utf8')), CLEANED)
    assert.equal(modeOf(real), 0o600)
    for (const name of backupsIn(dots)) assert.equal(modeOf(join(dots, name)), 0o600)
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
    assert.equal(readFileSync(box.settingsFile, 'utf8'), json(CLEANED))
  } finally {
    box.cleanup()
  }
})

// behavesAs

test('behavesAs reaches the picker rows through install.sh only when a non-empty string, and uninstall removes owned settings', async () => {
  const models = [
    { id: 'gpt-a', label: 'A', description: 'alpha', behavesAs: 'claude-opus-5-5' },
    { id: 'gpt-b', label: 'B', behavesAs: '' },
    { id: 'gpt-c', label: 'C', behavesAs: '   ' },
    { id: 'gpt-d', label: 'D', behavesAs: 42 },
    { id: 'gpt-e', label: 'E', behavesAs: null },
    { id: 'gpt-f', label: 'F', behavesAs: ['claude-opus-5-5'] },
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
    assert.deepEqual(ours[0], { model: 'gpt-a', label: 'A', description: 'alpha (codex-models)', behavesAs: 'claude-opus-5-5' })
    for (const row of ours.slice(1)) assert.ok(!('behavesAs' in row), `${row.model} has no behavesAs`)

    const removed = await box.run('uninstall.sh')
    assert.equal(removed.code, 0, removed.stderr)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), json(CLEANED))
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

test('after install, its dry run masks live and old tokens without changing settings', async () => {
  const box = sandbox()
  try {
    writeFileSync(box.settingsFile, json(ORIGINAL))
    assert.equal((await box.run('install.sh')).code, 0)
    const settings = JSON.parse(readFileSync(box.settingsFile, 'utf8'))
    settings.env.ANTHROPIC_CUSTOM_HEADERS = `x-ccmproxy-token: ${OLD1}\n${settings.env.ANTHROPIC_CUSTOM_HEADERS}`
    writeFileSync(box.settingsFile, json(settings))
    const before = readFileSync(box.settingsFile, 'utf8')
    const out = await box.run('install.sh', ['--dry-run'])
    assert.equal(out.code, 0, out.stderr)
    for (const secret of [OLD1, TOKEN]) assert.ok(!(out.stdout + out.stderr).includes(secret))
    assert.match(out.stdout, /x-ccmproxy-token: <secret>/)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), before)
    assert.deepEqual(filesHolding(box.root, [OLD1, TOKEN], [box.settingsFile, box.config, join(box.root, 'ccmproxy.mjs'), ...backupsIn(box.claude).map(n => join(box.claude, n))]), [])
  } finally {
    box.cleanup()
  }
})

test('old state and lock files are inert across check, dry run, install, reinstall and uninstall', async () => {
  const box = sandbox()
  try {
    const target = join(box.claude, 'codex-models')
    mkdirSync(target)
    const oldFiles = ['settings-state.json', 'codex.lock'].map(name => join(target, name))
    for (const file of oldFiles) writeFileSync(file, 'not JSON: leave untouched\n', { mode: 0o644 })
    const extra = box.preload(`
for (const name of ['existsSync', 'readFileSync', 'writeFileSync', 'openSync', 'statSync', 'lstatSync', 'chmodSync', 'realpathSync', 'renameSync', 'unlinkSync', 'rmSync']) {
  const original = fs[name]
  fs[name] = function (...args) {
    if (args.slice(0, 2).some(path => typeof path === 'string' && /(?:settings-state\\.json|codex\\.lock)$/.test(path))) {
      throw new Error('obsolete file I/O: ' + name)
    }
    return original.apply(this, args)
  }
}`)
    for (const args of [['--check'], ['--dry-run'], [], []]) {
      const out = await box.run('install.sh', args, extra)
      assert.equal(out.code, 0, out.stderr)
    }
    const removed = await box.run('uninstall.sh', [], extra)
    assert.equal(removed.code, 0, removed.stderr)
    for (const file of oldFiles) {
      assert.equal(readFileSync(file, 'utf8'), 'not JSON: leave untouched\n')
      assert.equal(modeOf(file), 0o644)
    }
    assert.deepEqual(JSON.parse(readFileSync(box.settingsFile, 'utf8')), {})
  } finally {
    box.cleanup()
  }
})

test('config loss or a changed port refuses install before build/copy/launchctl; uninstall then reinstall retains login and logs', async () => {
  const box = sandbox()
  try {
    assert.equal((await box.run('install.sh')).code, 0)
    const installed = readFileSync(box.settingsFile, 'utf8')
    const config = readFileSync(box.config, 'utf8')
    const copied = join(box.claude, 'codex-models/install/cli.mjs')
    const inode = lstatSync(copied).ino
    const backupNames = backupsIn(box.claude)
    for (const cfg of [undefined, JSON.stringify({ ...JSON.parse(config), listen_http: `127.0.0.1:${ports[1]}` })]) {
      if (cfg === undefined) rmSync(box.config)
      else writeFileSync(box.config, cfg)
      for (const args of [[], ['--check'], ['--dry-run']]) {
        const mark = box.calls().length
        const out = await box.run('install.sh', args)
        assert.notEqual(out.code, 0)
        assert.match(out.stderr, /uninstall first/)
        assert.doesNotMatch(box.calls().slice(mark), /launchctl|exec go/)
        assert.equal(readFileSync(box.settingsFile, 'utf8'), installed)
        assert.equal(lstatSync(copied).ino, inode)
        assert.deepEqual(backupsIn(box.claude), backupNames)
      }
    }
    const auth = join(box.claude, 'codex-models/home/auth')
    mkdirSync(auth)
    const login = join(auth, 'codex.json')
    const log = join(box.claude, 'codex-models/home/log/ccmproxy.log')
    writeFileSync(login, 'native login fixture\n', { mode: 0o600 })
    writeFileSync(log, 'log fixture\n')
    assert.equal((await box.run('uninstall.sh')).code, 0)
    assert.deepEqual(JSON.parse(readFileSync(box.settingsFile, 'utf8')), {})
    assert.equal((await box.run('install.sh')).code, 0)
    assert.equal(JSON.parse(readFileSync(box.settingsFile, 'utf8')).env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${ports[1]}`)
    assert.equal(readFileSync(login, 'utf8'), 'native login fixture\n')
    assert.equal(readFileSync(log, 'utf8'), 'log fixture\n')
    for (const name of backupNames) assert.ok(existsSync(join(box.claude, name)))
  } finally {
    box.cleanup()
  }
})

test('malformed containers abort uninstall before touching the LaunchAgent or backups', async () => {
  const box = sandbox()
  try {
    assert.equal((await box.run('install.sh')).code, 0)
    const plist = join(box.home, 'Library/LaunchAgents/com.anderson-spider.codex-models.plist')
    const before = readFileSync(plist, 'utf8')
    const names = backupsIn(box.claude)
    for (const value of [[], { env: [] }, { modelPicker: 'x' }, { modelPicker: { options: {} } }, { env: { ANTHROPIC_CUSTOM_HEADERS: 1 } }]) {
      const text = json(value)
      writeFileSync(box.settingsFile, text)
      const mark = box.calls().length
      const out = await box.run('uninstall.sh')
      assert.notEqual(out.code, 0)
      assert.match(out.stderr, /LaunchAgent stays loaded/)
      assert.doesNotMatch(box.calls().slice(mark), /launchctl/)
      assert.equal(readFileSync(box.settingsFile, 'utf8'), text)
      assert.equal(readFileSync(plist, 'utf8'), before)
      assert.deepEqual(backupsIn(box.claude), names)
    }
  } finally {
    box.cleanup()
  }
})

test('backup or atomic write failure keeps settings and the LaunchAgent loaded', async () => {
  for (const failure of ['backup', 'temp', 'rename']) {
    const box = sandbox()
    try {
      assert.equal((await box.run('install.sh')).code, 0)
      const current = readFileSync(box.settingsFile, 'utf8')
      const names = backupsIn(box.claude)
      const extra = box.preload(`
const open = fs.openSync
fs.openSync = function (path, ...args) {
  if (${JSON.stringify(failure)} === 'backup' && String(path).includes('.bak-codex-models-') || ${JSON.stringify(failure)} === 'temp' && String(path).endsWith('.tmp')) {
    throw Object.assign(new Error('injected write refusal'), { code: 'EACCES' })
  }
  return open.call(this, path, ...args)
}
const rename = fs.renameSync
fs.renameSync = function (...args) {
  if (${JSON.stringify(failure)} === 'rename') throw Object.assign(new Error('injected rename refusal'), { code: 'EACCES' })
  return rename.apply(this, args)
}`)
      const mark = box.calls().length
      const out = await box.run('uninstall.sh', [], extra)
      assert.notEqual(out.code, 0, failure)
      assert.match(out.stderr, /LaunchAgent stays loaded/)
      assert.doesNotMatch(out.stdout + out.stderr, new RegExp(TOKEN))
      assert.doesNotMatch(box.calls().slice(mark), /launchctl/)
      assert.equal(readFileSync(box.settingsFile, 'utf8'), current)
      assert.ok(existsSync(join(box.home, 'Library/LaunchAgents/com.anderson-spider.codex-models.plist')))
      const backups = backupsIn(box.claude)
      assert.equal(backups.length, names.length + (failure === 'backup' ? 0 : 1))
      for (const name of backups) assert.equal(modeOf(join(box.claude, name)), 0o600)
    } finally {
      box.cleanup()
    }
  }
})

test('a concurrent settings edit is not overwritten and keeps the LaunchAgent loaded', async () => {
  const box = sandbox()
  try {
    assert.equal((await box.run('install.sh')).code, 0)
    const installed = readFileSync(box.settingsFile, 'utf8')
    const changed = json({ ...JSON.parse(installed), theme: 'concurrent' })
    const extra = box.preload(`
const open = fs.openSync
fs.openSync = function (path, ...args) {
  const fd = open.call(this, path, ...args)
  if (String(path).endsWith('.tmp')) fs.writeFileSync(${JSON.stringify(box.settingsFile)}, ${JSON.stringify(changed)})
  return fd
}`)
    const mark = box.calls().length
    const out = await box.run('uninstall.sh', [], extra)
    assert.notEqual(out.code, 0)
    assert.match(out.stderr, /changed while this ran/)
    assert.match(out.stderr, /LaunchAgent stays loaded/)
    assert.doesNotMatch(box.calls().slice(mark), /launchctl/)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), changed)
    const backups = backupsIn(box.claude)
    assert.equal(readFileSync(join(box.claude, backups.at(-1)), 'utf8'), installed)
    assert.equal(readdirSync(box.claude).filter(name => name.endsWith('.tmp')).length, 0)
  } finally {
    box.cleanup()
  }
})

test('CLI rejects removed state arguments and unmerge dry run rather than ignoring them', async () => {
  const box = sandbox()
  try {
    for (const args of [
      ['precheck', '--state', 'unused'], ['merge', '--state', 'unused'], ['unmerge', '--state', 'unused'], ['unmerge', '--dry-run'],
    ]) {
      const out = await box.cli(args)
      assert.notEqual(out.code, 0)
      assert.match(out.stderr, /unexpected argument/)
      assert.deepEqual(readdirSync(box.claude), [])
    }
  } finally {
    box.cleanup()
  }
})
