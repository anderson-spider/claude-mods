// install.sh and uninstall.sh against a temporary HOME, with fakes for mise (Go build, node), launchctl and
// ccmproxy, and an in-process HTTP server playing the running proxy. Nothing touches the real HOME or launchd.
// Run: node --test plugins/codex-models/tests/scripts/*.test.mjs   (mise run plugins:test runs it)
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REPO = resolve(PLUGIN, '../..')
const TOKEN = 'fake-secret-0123456789'
const VERSION = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin/plugin.json'), 'utf8')).version

let server
let port
let mode = 'ours'

before(async () => {
  server = createServer((req, res) => {
    if (req.method === 'HEAD' && req.url === '/api/hello') return res.writeHead(200).end()
    if (req.url !== '/__ccmproxy/status') return res.writeHead(404).end()
    const signed = req.headers['x-ccmproxy-token'] === TOKEN
    if (mode === 'open' || signed) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ service: 'ccmproxy', version: VERSION, codexLogin: mode !== 'nologin', models: ['gpt-fake'] }))
    }
    if (mode === 'plain403') return res.writeHead(403).end('Forbidden')
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'ccmproxy: missing or wrong X-Ccmproxy-Token' } }))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  port = server.address().port
})

after(() => server.close())

/** A temporary HOME and PATH with the fakes; `run` runs a script of the plugin under them. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'codex-models-test-'))
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(bin)
  const node = process.execPath

  const script = (name, body) => {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }

  // The proxy's CLI as install.sh uses it: config init, env --shell json, models --json.
  writeFileSync(
    join(root, 'ccmproxy.mjs'),
    `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(join(root, 'calls.log'))}, 'ccmproxy ' + args.join(' ') + '\\n')
if (args.includes('--stdin')) writeFileSync(${JSON.stringify(join(root, 'stdin.json'))}, readFileSync(0))
const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
const config = flag('--config') ?? join(process.env.CCMPROXY_HOME, 'config.json')
if (args[0] === 'config') {
  if (!existsSync(config)) {
    mkdirSync(dirname(config), { recursive: true })
    writeFileSync(config, JSON.stringify({ listen_http: '127.0.0.1:${port}', auth_token: '${TOKEN}' }), { mode: 0o600 })
    console.log('Wrote ' + config)
  } else console.log(config + ' is up to date')
} else if (args[0] === 'env') {
  const c = JSON.parse(readFileSync(config, 'utf8'))
  console.log(JSON.stringify({ ANTHROPIC_BASE_URL: 'http://' + c.listen_http, ANTHROPIC_CUSTOM_HEADERS: 'X-Ccmproxy-Token: ' + c.auth_token, ENABLE_TOOL_SEARCH: 'true' }))
} else if (args[0] === 'models') {
  console.log(JSON.stringify([{ id: 'gpt-fake', label: 'GPT Fake', description: 'A fake Codex model' }]))
} else process.exit(3)
`,
  )
  writeFileSync(join(root, 'ccmproxy'), `#!/bin/sh\nexec "${node}" "${join(root, 'ccmproxy.mjs')}" "$@"\n`)
  chmodSync(join(root, 'ccmproxy'), 0o755)

  // mise: `where` answers, `exec go@… -- [env VAR=…] go … build -o OUT` records GOFLAGS as go sees it and copies the
  // fake proxy, `exec node@… -- node` runs node.
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
    if [ "$tool" = node ]; then exec "${node}" "$@"; fi
    if [ "$tool" = go ]; then
      echo "go GOFLAGS=[\${GOFLAGS-unset}] GOTOOLCHAIN=[\${GOTOOLCHAIN-unset}]" >>"${join(root, 'calls.log')}"
      while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { cp "${join(root, 'ccmproxy')}" "$2"; chmod +x "$2"; exit 0; }; shift; done
      exit 4
    fi
    exit 5 ;;
esac
exit 6
`,
  )
  script('launchctl', `#!/bin/sh\necho "launchctl $*" >>"${join(root, 'calls.log')}"\n[ "$1" = print ] && exit 1\nexit 0\n`)

  const run = (file, args = [], extra = {}) =>
    new Promise(done => {
      execFile(
        '/bin/sh',
        [join(PLUGIN, file), ...args],
        { env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: root, ...extra }, timeout: 30000 },
        (error, stdout, stderr) => done({ code: error ? error.code ?? 1 : 0, stdout, stderr }),
      )
    })
  const calls = () => (existsSync(join(root, 'calls.log')) ? readFileSync(join(root, 'calls.log'), 'utf8') : '')
  const settingsFile = join(home, '.claude/settings.json')
  return { root, home, run, calls, settingsFile, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const modeOf = path => statSync(path).mode & 0o777

/** settings.json and every codex-models backup beside it are mode 600. */
function assertPrivate(box) {
  const dir = join(box.home, '.claude')
  if (existsSync(box.settingsFile)) assert.equal(modeOf(box.settingsFile), 0o600, 'settings.json')
  const backups = readdirSync(dir).filter(name => name.startsWith('settings.json.bak-codex-models-'))
  for (const name of backups) assert.equal(modeOf(join(dir, name)), 0o600, name)
  return backups
}

const ORIGINAL = {
  env: { USE_BUILTIN_RIPGREP: '0', ANTHROPIC_CUSTOM_HEADERS: 'X-Team: blue' },
  modelPicker: { options: [{ model: 'claude-opus-4-8', label: 'Opus' }] },
  pluginConfigs: { 'crew@spider-claude-mods': { options: { codex: true } } },
}

test('both scripts parse', async () => {
  for (const file of ['install.sh', 'uninstall.sh']) {
    const code = await new Promise(done => execFile('/bin/sh', ['-n', join(PLUGIN, file)], error => done(error ? 1 : 0)))
    assert.equal(code, 0, file)
  }
})

test('the Go and Node pins match the root mise.toml', () => {
  const mise = readFileSync(join(REPO, 'mise.toml'), 'utf8')
  const install = readFileSync(join(PLUGIN, 'install.sh'), 'utf8')
  assert.equal(install.match(/^GO_VERSION=(.+)$/m)?.[1], mise.match(/^go = "(.+)"$/m)?.[1])
  assert.equal(install.match(/^NODE_VERSION=(.+)$/m)?.[1], mise.match(/^node = "(.+)"$/m)?.[1])
})

test('--check changes nothing', async () => {
  const box = sandbox()
  try {
    const out = await box.run('install.sh', ['--check'])
    assert.equal(out.code, 0, out.stderr)
    assert.match(out.stdout, new RegExp(`ready to install ${VERSION}`))
    assert.deepEqual(readdirSync(join(box.home, '.claude')), [])
    assert.doesNotMatch(box.calls(), /launchctl|exec go/)
  } finally {
    box.cleanup()
  }
})

test('--dry-run prints the settings diff with the secret masked and changes nothing', async () => {
  const box = sandbox()
  try {
    const text = `${JSON.stringify(ORIGINAL, null, 2)}\n`
    writeFileSync(box.settingsFile, text)
    const out = await box.run('install.sh', ['--dry-run'])

    assert.equal(out.code, 0, out.stderr)
    assert.match(out.stdout, new RegExp(`\\+\\s+"ANTHROPIC_BASE_URL": "http://127.0.0.1:${port}"`))
    assert.match(out.stdout, /X-Team: blue\\nX-Ccmproxy-Token: <secret>/)
    assert.match(out.stdout, /\(codex-models\)/)
    assert.doesNotMatch(out.stdout + out.stderr, new RegExp(TOKEN))
    assert.equal(readFileSync(box.settingsFile, 'utf8'), text)
    assert.deepEqual(readdirSync(join(box.home, '.claude')), ['settings.json'])
    assert.doesNotMatch(box.calls(), /launchctl/)
  } finally {
    box.cleanup()
  }
})

test('the proxy is built with GOFLAGS replaced and the pinned toolchain, whatever the environment says', async () => {
  const box = sandbox()
  try {
    writeFileSync(box.settingsFile, `${JSON.stringify(ORIGINAL, null, 2)}\n`)
    const out = await box.run('install.sh', ['--dry-run'], { GOFLAGS: '-tags=contract', GOTOOLCHAIN: 'go1.27.0' })
    assert.equal(out.code, 0, out.stderr)
    const calls = box.calls()
    // Not an empty GOFLAGS: Go would read that as unset and apply the one `go env -w` saved. GOTOOLCHAIN=local keeps
    // the go@ mise pinned, rather than one a GOTOOLCHAIN in the environment or `go env -w` would download.
    assert.match(calls, /exec go@\S+ -- env GOFLAGS=-tags= GOTOOLCHAIN=local go -C \S+ build -trimpath /)
    assert.match(calls, /^go GOFLAGS=\[-tags=\] GOTOOLCHAIN=\[local\]$/m)
    assert.doesNotMatch(calls, /contract|go1\.27\.0/)
  } finally {
    box.cleanup()
  }
})

test('--dry-run masks an old X-Ccmproxy-Token line as well as the new one', async () => {
  const box = sandbox()
  try {
    const old = 'old-secret-from-before-5e4d'
    writeFileSync(box.settingsFile, `${JSON.stringify({ env: { ANTHROPIC_CUSTOM_HEADERS: `X-Team: blue\nx-ccmproxy-token: ${old}` } }, null, 2)}\n`)
    const out = await box.run('install.sh', ['--dry-run'])

    assert.equal(out.code, 0, out.stderr)
    assert.match(out.stdout, /^-.*x-ccmproxy-token: <secret>/m)
    assert.match(out.stdout, /^\+.*X-Ccmproxy-Token: <secret>/m)
    assert.doesNotMatch(out.stdout + out.stderr, new RegExp(`${old}|${TOKEN}`))
  } finally {
    box.cleanup()
  }
})

test('install writes the settings after the preflight, and uninstall removes owned entries', async () => {
  mode = 'ours'
  const box = sandbox()
  try {
    writeFileSync(box.settingsFile, `${JSON.stringify(ORIGINAL, null, 2)}\n`, { mode: 0o644 })
    chmodSync(box.settingsFile, 0o644)
    // A backup an older install left readable is restricted too.
    const old = join(box.home, '.claude/settings.json.bak-codex-models-20260101-000000')
    writeFileSync(old, '{}\n')
    chmodSync(old, 0o644)
    const out = await box.run('install.sh')
    assert.equal(out.code, 0, out.stderr)
    assert.doesNotMatch(out.stdout + out.stderr, new RegExp(TOKEN))
    assert.ok(assertPrivate(box).length >= 2)

    const target = join(box.home, '.claude/codex-models')
    const settings = JSON.parse(readFileSync(box.settingsFile, 'utf8'))
    assert.equal(settings.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}`)
    assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, `X-Team: blue\nX-Ccmproxy-Token: ${TOKEN}`)
    assert.equal(settings.env.ENABLE_TOOL_SEARCH, 'true')
    assert.deepEqual(settings.modelPicker.options.at(-1), { model: 'gpt-fake', label: 'GPT Fake', description: 'A fake Codex model (codex-models)' })
    assert.deepEqual(settings.pluginConfigs, ORIGINAL.pluginConfigs)
    assert.ok(readdirSync(join(box.home, '.claude')).some(name => name.startsWith('settings.json.bak-codex-models-')))
    assert.ok(!existsSync(join(target, 'settings-state.json')), 'no state file created')
    for (const file of ['install.sh', 'uninstall.sh', 'install/cli.mjs', 'install/settings.mjs', 'ccmproxy', 'bin/ccmproxy', 'VERSION']) {
      assert.ok(existsSync(join(target, file)), file)
    }

    const plist = readFileSync(join(box.home, 'Library/LaunchAgents/com.anderson-spider.codex-models.plist'), 'utf8')
    assert.match(plist, /<key>CCMPROXY_HOME<\/key><string>[^<]+\/\.claude\/codex-models\/home<\/string>/)
    assert.match(plist, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/)
    assert.match(plist, /<key>ThrottleInterval<\/key><integer>30<\/integer>/)
    assert.match(plist, /home\/log\/ccmproxy\.log/)
    assert.match(box.calls(), /launchctl bootstrap gui\/\d+ /)
    const installCalls = box.calls()
    assert.ok(installCalls.indexOf('precheck --settings') < installCalls.indexOf('exec go@'))
    assert.ok(installCalls.indexOf('launchctl bootstrap') < installCalls.indexOf('preflight --env'))
    assert.ok(installCalls.indexOf('preflight --env') < installCalls.indexOf('merge --settings'))
    assert.doesNotMatch(installCalls, new RegExp(TOKEN))

    // A second run leaves the settings as the first wrote them.
    const once = readFileSync(box.settingsFile, 'utf8')
    chmodSync(box.settingsFile, 0o644) // as a person or another tool might leave it
    assert.equal((await box.run('install.sh')).code, 0)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), once)
    assertPrivate(box)

    // Uninstall from the copy, as a person without the plugin would.
    const removed = await new Promise(done =>
      execFile('/bin/sh', [join(target, 'uninstall.sh')], { env: { PATH: `${join(box.root, 'bin')}:/usr/bin:/bin`, HOME: box.home, TMPDIR: box.root } }, (error, stdout, stderr) =>
        done({ code: error ? 1 : 0, stdout, stderr }),
      ),
    )
    assert.equal(removed.code, 0, removed.stderr)
    assert.equal(JSON.stringify(JSON.parse(readFileSync(box.settingsFile, 'utf8'))), JSON.stringify(ORIGINAL))
    assertPrivate(box)
    assert.ok(!existsSync(join(box.home, 'Library/LaunchAgents/com.anderson-spider.codex-models.plist')))
    assert.ok(!existsSync(join(target, 'settings-state.json')))
    assert.ok(existsSync(join(target, 'home/config.json')), 'the config stays')
    const calls = box.calls()
    assert.ok(calls.lastIndexOf('launchctl bootout') > calls.lastIndexOf('launchctl bootstrap'))

  } finally {
    box.cleanup()
  }
})

test('a proxy that answers without the secret fails the preflight and the settings stay', async () => {
  mode = 'open'
  const box = sandbox()
  try {
    const text = `${JSON.stringify(ORIGINAL, null, 2)}\n`
    writeFileSync(box.settingsFile, text)
    const out = await box.run('install.sh')

    assert.notEqual(out.code, 0)
    assert.match(out.stderr, /answered 200 without the secret/)
    assert.match(out.stderr, /settings\.json was left alone/)
    assert.match(out.stderr, /LaunchAgent is loaded; .*\/\.claude\/codex-models\/uninstall\.sh removes it/)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), text)
  } finally {
    mode = 'ours'
    box.cleanup()
  }
})

test('a plain 403 without the secret is not ccmproxy: the preflight fails and the settings stay', async () => {
  mode = 'plain403'
  const box = sandbox()
  try {
    const text = `${JSON.stringify(ORIGINAL, null, 2)}\n`
    writeFileSync(box.settingsFile, text)
    const out = await box.run('install.sh')

    assert.notEqual(out.code, 0)
    assert.match(out.stderr, /answered a 403 that is not its refusal without the secret/)
    assert.match(out.stderr, /not ccmproxy/)
    assert.match(out.stderr, /settings\.json was left alone/)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), text)
    assert.ok(!readdirSync(join(box.home, '.claude')).some(name => name.includes('.bak-codex-models-')))
  } finally {
    mode = 'ours'
    box.cleanup()
  }
})

/** Nothing of the install happened: no build, no home, no plist, no launchctl call, no backup. */
function assertUntouched(box) {
  assert.ok(!existsSync(join(box.home, '.claude/codex-models')), 'no install home')
  assert.ok(!existsSync(join(box.home, 'Library/LaunchAgents')), 'no plist')
  assert.doesNotMatch(box.calls(), /launchctl|exec go/)
  assert.ok(!readdirSync(join(box.home, '.claude')).some(name => name.includes('.bak-codex-models-')))
}

test('only regular backup files are restricted: a link or a directory under the backup name is left alone', async () => {
  mode = 'ours'
  const box = sandbox()
  try {
    writeFileSync(box.settingsFile, `${JSON.stringify(ORIGINAL, null, 2)}\n`)
    const dir = join(box.home, '.claude/settings.json.bak-codex-models-dir')
    mkdirSync(dir)
    chmodSync(dir, 0o755)
    const elsewhere = join(box.root, 'elsewhere.txt')
    writeFileSync(elsewhere, 'x')
    chmodSync(elsewhere, 0o644)
    symlinkSync(elsewhere, join(box.home, '.claude/settings.json.bak-codex-models-link'))

    const out = await box.run('install.sh')
    assert.equal(out.code, 0, out.stderr)
    assert.equal(modeOf(dir), 0o755)
    assert.equal(modeOf(elsewhere), 0o644)
    const made = readdirSync(join(box.home, '.claude')).filter(name => /^settings\.json\.bak-codex-models-\d/.test(name))
    assert.equal(made.length, 1)
    assert.equal(modeOf(join(box.home, '.claude', made[0])), 0o600)
  } finally {
    box.cleanup()
  }
})

test('a base URL that is not ours is refused before anything is built or loaded', async () => {
  const box = sandbox()
  try {
    const text = `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gateway.example.com' } }, null, 2)}\n`
    writeFileSync(box.settingsFile, text)
    const out = await box.run('install.sh')

    assert.notEqual(out.code, 0)
    assert.match(out.stderr, /already set to a different URL/)
    assert.match(out.stderr, /nothing was changed/)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), text)
    assertUntouched(box)

    const check = await box.run('install.sh', ['--check'])
    assert.notEqual(check.code, 0)
    assert.match(check.stderr, /already set to a different URL/)
  } finally {
    box.cleanup()
  }
})

test('a malformed settings.json is refused before anything is built or loaded', async () => {
  const box = sandbox()
  try {
    for (const text of ['{ "env": ', '{ "env": "x" }\n']) {
      writeFileSync(box.settingsFile, text)
      const out = await box.run('install.sh')

      assert.notEqual(out.code, 0)
      assert.match(out.stderr, /not valid JSON|"env" that is not an object/)
      assert.equal(readFileSync(box.settingsFile, 'utf8'), text)
      assertUntouched(box)
    }
  } finally {
    box.cleanup()
  }
})

test('with no settings.json before install, uninstall keeps the file as {}', async () => {
  mode = 'ours'
  const box = sandbox()
  try {
    assert.equal((await box.run('install.sh')).code, 0)
    assert.ok(existsSync(box.settingsFile))

    const out = await box.run('uninstall.sh')
    assert.equal(out.code, 0, out.stderr)
    assert.deepEqual(JSON.parse(readFileSync(box.settingsFile, 'utf8')), {})
  } finally {
    box.cleanup()
  }
})

test('with no settings.json before install, a key added since keeps the file', async () => {
  mode = 'ours'
  const box = sandbox()
  try {
    assert.equal((await box.run('install.sh')).code, 0)
    const settings = JSON.parse(readFileSync(box.settingsFile, 'utf8'))
    writeFileSync(box.settingsFile, `${JSON.stringify({ ...settings, theme: 'dark' }, null, 2)}\n`)

    assert.equal((await box.run('uninstall.sh')).code, 0)
    assert.deepEqual(JSON.parse(readFileSync(box.settingsFile, 'utf8')), { theme: 'dark' })
  } finally {
    box.cleanup()
  }
})

test('the remote URL and management key reach config init on stdin, never argv, plist or output', async () => {
  mode = 'ours'
  const box = sandbox()
  try {
    const key = 'mgmt-key-sentinel-9f8e7d'
    const remote = 'https://remote.example.net'
    for (const args of [['--dry-run'], []]) {
      rmSync(join(box.root, 'stdin.json'), { force: true })
      const out = await box.run('install.sh', args, { CLIPROXY_URL: remote, CLIPROXY_MGMT_KEY: key })
      assert.equal(out.code, 0, out.stderr)
      assert.deepEqual(JSON.parse(readFileSync(join(box.root, 'stdin.json'), 'utf8')), { codex: { remote, management_key: key } })
      assert.doesNotMatch(out.stdout + out.stderr, new RegExp(key))
    }
    assert.match(box.calls(), /^ccmproxy config init --stdin$/m)
    assert.doesNotMatch(box.calls(), new RegExp(key))
    assert.doesNotMatch(readFileSync(join(box.home, 'Library/LaunchAgents/com.anderson-spider.codex-models.plist'), 'utf8'), new RegExp(key))

    // Without either variable a reinstall keeps the configured remote: plain config init.
    const mark = box.calls().length
    assert.equal((await box.run('install.sh')).code, 0)
    assert.match(box.calls().slice(mark), /^ccmproxy config init$/m)
  } finally {
    box.cleanup()
  }
})

test('remote-input passes an HTTP LAN URL unchanged to config init on stdin', async () => {
  mode = 'ours'
  const box = sandbox()
  try {
    const remote = 'http://192.168.0.128:8317'
    const key = 'mgmt-key-sentinel-http'
    for (const args of [['--dry-run'], []]) {
      rmSync(join(box.root, 'stdin.json'), { force: true })
      const out = await box.run('install.sh', args, { CLIPROXY_URL: remote, CLIPROXY_MGMT_KEY: key })
      assert.equal(out.code, 0, out.stderr)
      assert.deepEqual(JSON.parse(readFileSync(join(box.root, 'stdin.json'), 'utf8')), { codex: { remote, management_key: key } })
      assert.doesNotMatch(out.stdout + out.stderr, new RegExp(key))
    }
    assert.match(box.calls(), /^ccmproxy config init --stdin$/m)
    assert.doesNotMatch(box.calls(), new RegExp(key))
    assert.doesNotMatch(readFileSync(join(box.home, 'Library/LaunchAgents/com.anderson-spider.codex-models.plist'), 'utf8'), new RegExp(key))
  } finally {
    box.cleanup()
  }
})

test('only one of CLIPROXY_URL and CLIPROXY_MGMT_KEY is a usage error before anything changes', async () => {
  const box = sandbox()
  try {
    for (const extra of [{ CLIPROXY_URL: 'https://remote.example.net' }, { CLIPROXY_MGMT_KEY: 'k' }]) {
      const out = await box.run('install.sh', [], extra)
      assert.equal(out.code, 2, out.stderr)
      assert.match(out.stderr, /set both CLIPROXY_URL and CLIPROXY_MGMT_KEY/)
      assert.equal(box.calls(), '')
      assert.deepEqual(readdirSync(join(box.home, '.claude')), [])
    }
  } finally {
    box.cleanup()
  }
})

test('the preflight names a missing remote account and how to add it', async () => {
  mode = 'nologin'
  const box = sandbox()
  try {
    const out = await box.run('install.sh')
    assert.equal(out.code, 0, out.stderr)
    assert.match(out.stdout, /Codex remote account not confirmed, so quota is unavailable \(to set the remote, set CLIPROXY_URL and CLIPROXY_MGMT_KEY/)
    assert.doesNotMatch(out.stdout, /login codex/)
  } finally {
    mode = 'ours'
    box.cleanup()
  }
})

test('removed flags are usage errors before any prerequisites or filesystem changes', async () => {
  const box = sandbox()
  try {
    for (const [file, args] of [
      ['install.sh', ['--no-settings']], ['uninstall.sh', ['--dry-run']], ['uninstall.sh', ['--purge']],
    ]) {
      const out = await box.run(file, args)
      assert.equal(out.code, 2, out.stderr)
      assert.match(out.stderr, /usage:/)
      assert.equal(box.calls(), '')
      assert.deepEqual(readdirSync(join(box.home, '.claude')), [])
    }
  } finally {
    box.cleanup()
  }
})
