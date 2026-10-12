// The file and network half of install.sh and uninstall.sh; the decisions are settings.mjs's.
//
//   node cli.mjs version-of <plugin.json>
//   node cli.mjs precheck  --settings <file> --state <file> --config <file>
//   node cli.mjs preflight --env <file> --version <v> [--wait-ms <ms>]
//   node cli.mjs merge     --settings <file> --state <file> --env <file> --models <file> [--dry-run]
//   node cli.mjs unmerge   --settings <file> --state <file> [--dry-run]
//
// <env> is `ccmproxy env --shell json` output and <models> `ccmproxy models --json`, both in files rather than
// arguments, so the secret never shows in a process list. Nothing printed carries the secret.
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  lstatSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  HEADER,
  isOurHeader,
  masked,
  maskedSettings,
  ownerRefusal,
  planInstall,
  planUninstall,
  readStatusReply,
  secretOf,
  settingsRefusal,
} from './settings.mjs'

class Refusal extends Error {}

const fail = message => {
  throw new Refusal(message)
}

function flags(args) {
  const out = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('--')) fail(`unexpected argument ${arg}`)
    const name = arg.slice(2)
    if (name === 'dry-run') out.dryRun = true
    else if (i + 1 < args.length) out[name] = args[++i]
    else fail(`${arg} needs a value`)
  }
  return out
}

function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`${what} (${file}) is not readable JSON: ${error.code ?? error.message}`)
  }
}

/** Where a settings path lands: through a symbolic link (a dotfiles checkout), so the link stays a link. */
const landing = file => (existsSync(file) ? realpathSync(file) : file)

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')

/** Refuses a file that holds or will hold the secret when it is not the user's own (mode 600 needs the owner). */
function ensureOwn(file) {
  const target = landing(file)
  const refusal = ownerRefusal(target, existsSync(target) ? statSync(target).uid : undefined, process.getuid())
  if (refusal) fail(refusal)
  return target
}

/** Creates `path` with `text`, mode 600 from the first byte, or fails naming the path; `flag` `wx` never overwrites. */
function writePrivate(path, text) {
  let fd
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') throw error
    fail(`cannot write ${path} (${error.code}): the file holding the proxy's secret must be restricted to mode 600; nothing was changed`)
  }
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(path, 0o600) // the umask can only narrow the mode; this states it
}

/**
 * Writes `text` beside `file` and renames it over, so the file ends at mode 600 whatever it was (it holds the
 * secret); `expect` is what must still be there.
 */
function writeAtomic(file, text, expect) {
  const target = ensureOwn(file)
  const temp = join(dirname(target), `.${basename(target)}.codex-models-${process.pid}.tmp`)
  writePrivate(temp, text)
  // Claude Code rewrites this file too (/config, plugin configure): a change since it was read is not overwritten.
  const now = existsSync(target) ? readFileSync(target, 'utf8') : undefined
  if (now !== expect) {
    unlinkSync(temp)
    fail(`${file} changed while this ran; nothing was written, run it again`)
  }
  renameSync(temp, target)
}

/**
 * Restricts the user's own earlier backups of `target` to mode 600; returns their name prefix. Only regular files
 * count: a link or a directory under that name is left as it is (lstat, so a link is never followed).
 */
function restrictBackups(target) {
  const dir = dirname(target)
  const prefix = `${basename(target)}.bak-codex-models-`
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue
    const path = join(dir, name)
    const entry = lstatSync(path)
    if (entry.isFile() && entry.uid === process.getuid()) chmodSync(path, 0o600)
  }
  return prefix
}

/**
 * A copy beside the file, mode 600, under a name no earlier backup has (install and uninstall can run within one
 * second). Earlier backups of the user's own are restricted too: an older install may have left them readable.
 */
function backup(file) {
  const target = ensureOwn(file)
  const dir = dirname(target)
  const prefix = restrictBackups(target)
  const text = readFileSync(target, 'utf8')
  const base = join(dir, `${prefix}${stamp()}`)
  for (let n = 0; ; n++) {
    const copy = n === 0 ? base : `${base}-${n}`
    try {
      writePrivate(copy, text)
      return copy
    } catch (error) {
      if (error.code !== 'EEXIST' || n >= 99) throw error
    }
  }
}

const formatted = value => `${JSON.stringify(value, null, 2)}\n`

function readSettings(file) {
  const target = landing(file)
  if (!existsSync(target)) return { text: undefined, value: {} }
  const text = readFileSync(target, 'utf8')
  try {
    return { text, value: text.trim() === '' ? {} : JSON.parse(text) }
  } catch {
    fail(`${file} is not valid JSON; fix it first (nothing was changed)`)
  }
}

/** Prints the diff of two settings values (undefined: no file), every X-Ccmproxy-Token value masked in both. */
function printDiff(beforeValue, afterValue, secret, label) {
  const show = value => (value === undefined ? '' : masked(formatted(maskedSettings(value)), secret))
  const before = show(beforeValue)
  const after = show(afterValue)
  const dir = mkdtempSync(join(tmpdir(), 'codex-models-'))
  try {
    const a = join(dir, 'before.json')
    const b = join(dir, 'after.json')
    writeFileSync(a, before, { mode: 0o600 })
    writeFileSync(b, after, { mode: 0o600 })
    const diff = spawnSync('diff', ['-u', '--label', `${label} (now)`, '--label', `${label} (after)`, a, b], { encoding: 'utf8' })
    process.stdout.write(diff.stdout || 'no change\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function merge(opts) {
  const env = readJson(opts.env, 'the proxy environment')
  const models = readJson(opts.models, 'the model list')
  const prior = existsSync(opts.state) ? readJson(opts.state, 'the install state') : undefined
  const current = readSettings(opts.settings)
  const plan = planInstall(current.value, env, models, prior, current.text !== undefined)
  if (plan.error) fail(plan.error)

  const secret = typeof env.ANTHROPIC_CUSTOM_HEADERS === 'string' ? secretOf(env.ANTHROPIC_CUSTOM_HEADERS) : ''
  const after = formatted(plan.settings)
  if (opts.dryRun) {
    printDiff(current.text === undefined ? undefined : current.value, plan.settings, secret, opts.settings)
    return
  }

  // The state goes first and records the new base URL beside the old ones, so an install stopped before the
  // settings write still lets uninstall recognize whichever URL the settings hold.
  ensureOwn(opts.settings)
  writeAtomic(opts.state, formatted(plan.state), existsSync(opts.state) ? readFileSync(landing(opts.state), 'utf8') : undefined)
  if (current.text !== undefined && after === current.text) {
    // Nothing to write, but the file holds the secret: an earlier install may have left it readable.
    const target = landing(opts.settings)
    chmodSync(target, 0o600)
    restrictBackups(target)
    console.log(`settings: ${opts.settings} already holds the codex-models entries`)
    return
  }
  const copy = current.text === undefined ? undefined : backup(opts.settings)
  writeAtomic(opts.settings, after, current.text)
  console.log(`settings: wrote ANTHROPIC_BASE_URL, the ${HEADER} header, ENABLE_TOOL_SEARCH and ${plan.state.models.length} /model rows to ${opts.settings}`)
  if (copy) console.log(`settings: the previous file is in ${copy}`)
}

function unmerge(opts) {
  // Both files are written or removed below: one that is not the user's is refused before anything changes.
  ensureOwn(opts.settings)
  ensureOwn(opts.state)
  const state = existsSync(opts.state) ? readJson(opts.state, 'the install state') : undefined
  const current = readSettings(opts.settings)
  if (current.text === undefined) {
    console.log(`settings: ${opts.settings} does not exist; nothing to take out`)
    if (!opts.dryRun && state) rmSync(opts.state, { force: true })
    return
  }
  const plan = planUninstall(current.value, state)
  if (plan.error) fail(plan.error)

  const headers = current.value?.env?.ANTHROPIC_CUSTOM_HEADERS
  const ours = typeof headers === 'string' ? headers.split(/\r?\n/).find(isOurHeader) : undefined
  const before = formatted(current.value)
  // A file install created, holding nothing else now, goes as it came.
  const after = plan.remove ? '' : formatted(plan.settings)
  if (opts.dryRun) {
    printDiff(current.value, plan.remove ? undefined : plan.settings, ours ? secretOf(ours) : '', opts.settings)
    return
  }
  if (plan.remove) {
    const copy = backup(opts.settings)
    const target = landing(opts.settings)
    if (readFileSync(target, 'utf8') !== current.text) fail(`${opts.settings} changed while this ran; nothing was written, run it again`)
    unlinkSync(target)
    console.log(`settings: removed ${opts.settings}, which install created and nothing else uses (previous file: ${copy})`)
  } else if (before === after) {
    console.log(`settings: ${opts.settings} holds no codex-models entries`)
  } else {
    const copy = backup(opts.settings)
    writeAtomic(opts.settings, after, current.text)
    console.log(`settings: took the codex-models entries out of ${opts.settings} (previous file: ${copy})`)
  }
  if (state) rmSync(opts.state, { force: true })
}

/**
 * Whether install would refuse the settings, asked before anything is built or loaded. The proxy's base URL comes
 * from its config when one exists; before the first install there is none, and any base URL already set is refused.
 */
function precheck(opts) {
  // Both files get the secret later: one that is not the user's is refused before anything is built or loaded.
  ensureOwn(opts.settings)
  ensureOwn(opts.state)
  const prior = existsSync(opts.state) ? readJson(opts.state, 'the install state') : undefined
  const current = readSettings(opts.settings)
  let baseUrl
  if (existsSync(opts.config)) {
    const listen = readJson(opts.config, 'the proxy config').listen_http
    if (typeof listen === 'string') baseUrl = `http://${listen}`
  }
  const refusal = settingsRefusal(current.value, baseUrl, prior)
  if (refusal) fail(refusal)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function request(url, init) {
  try {
    const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(2000) })
    return { status: response.status, text: await response.text() }
  } catch {
    return undefined // refused, reset or too slow: the proxy is not up yet
  }
}

/**
 * Proves the proxy on the base URL is this install's before the settings point every session at it: the start
 * probe answers, the status refuses a request without the secret, and with it names ccmproxy at this version.
 */
async function preflight(opts) {
  const env = readJson(opts.env, 'the proxy environment')
  const base = String(env.ANTHROPIC_BASE_URL ?? '').replace(/\/+$/, '')
  const secret = secretOf(String(env.ANTHROPIC_CUSTOM_HEADERS ?? ''))
  const deadline = Date.now() + Number(opts['wait-ms'] ?? 20000)

  let bare
  while (!(bare = await request(`${base}/__ccmproxy/status`))) {
    if (Date.now() > deadline) fail(`nothing answers at ${base}; see ~/.claude/codex-models/home/log/ccmproxy.log`)
    await sleep(250)
  }
  // Only ccmproxy's own refusal counts: any server can answer a bare 403.
  if (readStatusReply(bare.status, bare.text).kind !== 'forbidden') {
    const answer = bare.status === 403 ? 'a 403 that is not its refusal' : String(bare.status)
    fail(`${base}/__ccmproxy/status answered ${answer} without the secret (ccmproxy's 403 expected): not ccmproxy, another server may hold the port`)
  }

  const hello = await request(`${base}/api/hello`, { method: 'HEAD' })
  if (hello?.status !== 200) fail(`${base}/api/hello answered ${hello?.status ?? 'nothing'} (200 expected)`)

  const signed = await request(`${base}/__ccmproxy/status`, { headers: { [HEADER]: secret } })
  if (!signed) fail(`${base} stopped answering`)
  const reply = readStatusReply(signed.status, signed.text)
  if (reply.kind === 'forbidden') fail(`${base} refused the secret from the config: the running proxy reads another config`)
  if (reply.kind === 'host') fail(`${base} refused the Host header: the running proxy listens on another address`)
  if (reply.kind === 'foreign') fail(`${base} is not ccmproxy (${reply.reason})`)
  if (reply.version !== opts.version) {
    fail(`${base} runs ccmproxy ${reply.version || 'of no version'}, ${opts.version} expected: an older proxy may still hold the port`)
  }
  console.log(`preflight: ccmproxy ${reply.version} answers at ${base}; Codex login ${reply.codexLogin ? 'present' : 'missing'}`)
}

async function main([command, ...args]) {
  if (command === 'version-of') {
    const version = readJson(args[0], 'plugin.json').version
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) fail(`${args[0]} has no version`)
    console.log(version)
    return
  }
  const opts = flags(args)
  const need = names => names.forEach(name => opts[name] || fail(`${command} needs --${name}`))
  if (command === 'precheck') return need(['settings', 'state', 'config']), precheck(opts)
  if (command === 'preflight') return need(['env', 'version']), preflight(opts)
  if (command === 'merge') return need(['settings', 'state', 'env', 'models']), merge(opts)
  if (command === 'unmerge') return need(['settings', 'state']), unmerge(opts)
  fail(`unknown command ${command ?? '(none)'}`)
}

main(process.argv.slice(2)).catch(error => {
  console.error(`codex-models: ${error instanceof Refusal ? error.message : error.stack ?? error}`)
  process.exitCode = 1
})
