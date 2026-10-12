// install.sh and uninstall.sh against a temporary HOME, with fakes for mise (Go build, node), launchctl and
// ccmproxy, and an in-process HTTP server playing the running proxy. Nothing touches the real HOME or launchd.
// Run: node --test plugins/codex-models/tests/scripts/*.test.mjs   (mise run plugins:test runs it)
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
      return res.end(JSON.stringify({ service: 'ccmproxy', version: VERSION, codexLogin: false, models: ['gpt-fake'] }))
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
    `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const args = process.argv.slice(2)
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

  // mise: `where` answers, `exec go@… -- go … build -o OUT` copies the fake proxy, `exec node@… -- node` runs node.
  script(
    'mise',
    `#!/bin/sh
echo "mise $*" >>"${join(root, 'calls.log')}"
case "$1" in
  where) echo /fake/install; exit 0 ;;
  exec)
    shift 2; [ "$1" = "--" ] && shift
    tool=$1; shift
    if [ "$tool" = node ]; then exec "${node}" "$@"; fi
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

  const run = (file, args = []) =>
    new Promise(done => {
      execFile(
        '/bin/sh',
        [join(PLUGIN, file), ...args],
        { env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: root }, timeout: 30000 },
        (error, stdout, stderr) => done({ code: error ? error.code ?? 1 : 0, stdout, stderr }),
      )
    })
  const calls = () => (existsSync(join(root, 'calls.log')) ? readFileSync(join(root, 'calls.log'), 'utf8') : '')
  const settingsFile = join(home, '.claude/settings.json')
  return { root, home, run, calls, settingsFile, cleanup: () => rmSync(root, { recursive: true, force: true }) }
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

test('install writes the settings after the preflight, and uninstall restores them', async () => {
  mode = 'ours'
  const box = sandbox()
  try {
    writeFileSync(box.settingsFile, `${JSON.stringify(ORIGINAL, null, 2)}\n`)
    const out = await box.run('install.sh')
    assert.equal(out.code, 0, out.stderr)
    assert.doesNotMatch(out.stdout + out.stderr, new RegExp(TOKEN))

    const target = join(box.home, '.claude/codex-models')
    const settings = JSON.parse(readFileSync(box.settingsFile, 'utf8'))
    assert.equal(settings.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}`)
    assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, `X-Team: blue\nX-Ccmproxy-Token: ${TOKEN}`)
    assert.equal(settings.env.ENABLE_TOOL_SEARCH, 'true')
    assert.deepEqual(settings.modelPicker.options.at(-1), { model: 'gpt-fake', label: 'GPT Fake', description: 'A fake Codex model (codex-models)' })
    assert.deepEqual(settings.pluginConfigs, ORIGINAL.pluginConfigs)
    assert.ok(readdirSync(join(box.home, '.claude')).some(name => name.startsWith('settings.json.bak-codex-models-')))
    assert.doesNotMatch(readFileSync(join(target, 'settings-state.json'), 'utf8'), new RegExp(TOKEN))
    for (const file of ['install.sh', 'uninstall.sh', 'install/cli.mjs', 'install/settings.mjs', 'ccmproxy', 'bin/ccmproxy', 'VERSION']) {
      assert.ok(existsSync(join(target, file)), file)
    }

    const plist = readFileSync(join(box.home, 'Library/LaunchAgents/com.anderson-spider.codex-models.plist'), 'utf8')
    assert.match(plist, /<key>CCMPROXY_HOME<\/key><string>[^<]+\/\.claude\/codex-models\/home<\/string>/)
    assert.match(plist, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/)
    assert.match(plist, /<key>ThrottleInterval<\/key><integer>30<\/integer>/)
    assert.match(plist, /home\/log\/ccmproxy\.log/)
    assert.match(box.calls(), /launchctl bootstrap gui\/\d+ /)

    // A second run leaves the settings as the first wrote them.
    const once = readFileSync(box.settingsFile, 'utf8')
    assert.equal((await box.run('install.sh')).code, 0)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), once)

    // Uninstall from the copy, as a person without the plugin would.
    const removed = await new Promise(done =>
      execFile('/bin/sh', [join(target, 'uninstall.sh')], { env: { PATH: `${join(box.root, 'bin')}:/usr/bin:/bin`, HOME: box.home, TMPDIR: box.root } }, (error, stdout, stderr) =>
        done({ code: error ? 1 : 0, stdout, stderr }),
      ),
    )
    assert.equal(removed.code, 0, removed.stderr)
    assert.equal(JSON.stringify(JSON.parse(readFileSync(box.settingsFile, 'utf8'))), JSON.stringify(ORIGINAL))
    assert.ok(!existsSync(join(box.home, 'Library/LaunchAgents/com.anderson-spider.codex-models.plist')))
    assert.ok(!existsSync(join(target, 'settings-state.json')))
    assert.ok(existsSync(join(target, 'home/config.json')), 'the config stays without --purge')
    const calls = box.calls()
    assert.ok(calls.lastIndexOf('launchctl bootout') > calls.lastIndexOf('launchctl bootstrap'))

    assert.equal((await box.run('uninstall.sh', ['--purge'])).code, 0)
    assert.ok(!existsSync(target))
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

test('a base URL that is not ours is refused before anything is built or loaded', async () => {
  const box = sandbox()
  try {
    const text = `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gateway.example.com' } }, null, 2)}\n`
    writeFileSync(box.settingsFile, text)
    const out = await box.run('install.sh')

    assert.notEqual(out.code, 0)
    assert.match(out.stderr, /already "https:\/\/gateway\.example\.com"/)
    assert.match(out.stderr, /nothing was changed/)
    assert.equal(readFileSync(box.settingsFile, 'utf8'), text)
    assertUntouched(box)

    const check = await box.run('install.sh', ['--check'])
    assert.notEqual(check.code, 0)
    assert.match(check.stderr, /already "https:\/\/gateway\.example\.com"/)
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

test('with no settings.json before install, uninstall removes the file it created', async () => {
  mode = 'ours'
  const box = sandbox()
  try {
    assert.equal((await box.run('install.sh')).code, 0)
    assert.ok(existsSync(box.settingsFile))
    assert.equal(JSON.parse(readFileSync(join(box.home, '.claude/codex-models/settings-state.json'), 'utf8')).fileCreated, true)

    const out = await box.run('uninstall.sh')
    assert.equal(out.code, 0, out.stderr)
    assert.ok(!existsSync(box.settingsFile))
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

test('--no-settings installs and leaves the settings alone', async () => {
  const box = sandbox()
  try {
    const out = await box.run('install.sh', ['--no-settings'])

    assert.equal(out.code, 0, out.stderr)
    assert.ok(!existsSync(box.settingsFile))
    assert.match(out.stdout, /--no-settings/)
  } finally {
    box.cleanup()
  }
})
