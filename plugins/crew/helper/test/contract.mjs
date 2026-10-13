// The one declared copy of everything that crosses the hooks/helper/scripts boundary, and the examples both halves
// are checked against. The plugin half (tests/contract.test.ts) compares hooks/appserver.ts with it; the helper half
// (contract.test.mjs) compares helper.mjs, lib/lanes.mjs, lib/engine.mjs, install.sh and uninstall.sh. Changing a
// route, a reply's keys, a role or the label here fails both halves until each side follows. Types in contract.d.mts.
export const contract = {
  // Route name -> path the helper serves, POSTed over its Unix socket (`/status` answers any method).
  routes: {
    start: '/start',
    poll: '/poll',
    interrupt: '/interrupt',
    reset: '/reset',
    status: '/status',
  },
  // The sorted key set of every reply, as the helper sends it and hooks/appserver.ts types it.
  replies: {
    start: { started: ['status'], busy: ['status'], full: ['message', 'status'], error: ['message', 'status'] },
    poll: { running: ['seconds', 'status'], idle: ['status'], ok: ['commands', 'declined', 'error', 'files', 'status', 'text', 'turn'] },
    interrupt: { ok: ['interrupted', 'status'] },
    reset: { ok: ['status'] },
    status: { ok: ['codex', 'jobs', 'login', 'pid', 'status', 'threads', 'version'] },
  },
  // The keys of a `/start` body, which hooks send and the helper reads.
  startRequest: ['caller', 'effort', 'instructions', 'model', 'prompt', 'repo', 'role'],
  // The roles the helper has a lane for, and hooks sends.
  roles: ['digger'],
  // The LaunchAgent label: install.sh and uninstall.sh declare it, hooks/appserver.ts kickstarts it.
  label: 'com.anderson-spider.crew-codex',
  // `callerOf(agentId)` must give `caller`, and the helper must accept it.
  callers: [
    { agent: 'agent-a', caller: 'agent-a' },
    { agent: 'a b', caller: 'a_b' },
    { agent: 'a/b', caller: 'a_b' },
    { agent: '../x', caller: 'x' },
    { agent: '_hidden', caller: 'hidden' },
    { agent: '', caller: 'x' },
    { agent: 'a:b.c-d_e', caller: 'a:b.c-d_e' },
  ],
  // The longest caller the helper accepts, and callerOf produces.
  maxPart: 128,
  // What the helper refuses as a caller, and callerOf never produces.
  notCallers: ['', '/', 'a/b', '.a', '_a', '-a', ':a', 'a b', '../x', 'a\n', 'ün'],
  // Homes `socketOf` is given, and where the installed helper's socket sits under one.
  home: ['/home/me', '/Users/someone', ''],
  socketUnderHome: '.claude/mcp/crew-codex/run/helper.sock',
  // A reply of each shape, as the helper sends it, that hooks must consume.
  examples: {
    pollOk: { status: 'ok', turn: 'completed', text: 'done', files: [{ status: 'completed', paths: ['/r/a.ts'] }], commands: [{ command: 'ls', status: 'completed', exitCode: 0 }], declined: 0, error: null },
    status: { status: 'ok', version: '0.4.0', pid: 1, jobs: 0, threads: 0, codex: true, login: true },
  },
}
