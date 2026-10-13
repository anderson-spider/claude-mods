// The one declared copy of everything that crosses the hooks/helper/scripts
// boundary, and the examples both halves are checked against. The plugin half
// (tests/contract.test.ts) compares hooks/model.ts and hooks/helper.ts with it;
// the helper half (contract.test.mjs) compares helper.mjs, lib/approvals.mjs,
// lib/hub.mjs, install.sh and uninstall.sh. Changing a route, a choice, the lease
// or the label here fails both halves until each side follows. Types in contract.d.mts.
export const contract = {
  // Route name -> path the helper serves, POSTed over its Unix socket (`/status` answers any method).
  routes: {
    call: '/call',
    reset: '/reset',
    approve: '/approve',
    release: '/release',
    settings: '/settings',
    forget: '/forget',
    status: '/status',
  },
  // The person's answers to an approval question, as `/approve` takes them.
  choices: ['session', 'always', 'deny'],
  // How long an app stays with the caller that last used it (hub.mjs `LEASE_MS`, the text the model reads).
  leaseMinutes: 2,
  // The LaunchAgent label: install.sh and uninstall.sh declare it, hooks/helper.ts kickstarts it.
  label: 'com.anderson-spider.codex-cu',
  // `callerOf(session, agent)` must give `caller`, and the helper must accept it.
  callers: [
    { session: 'sess-1', caller: 'sess-1' },
    { session: 'sess-1', agent: 'agent-a', caller: 'sess-1/agent-a' },
    { session: 'sess-1', agent: '', caller: 'sess-1' },
    { session: 'a b', agent: 'agent a', caller: 'a_b/agent_a' },
    { session: 's', agent: 'a/b', caller: 's/a_b' },
    { session: '../x', caller: 'x' },
    { session: '_hidden', caller: 'hidden' },
    { session: 's', agent: '..', caller: 's/x' },
    { session: '', caller: 'x' },
    { session: 'ünï', caller: 'n_' },
    { session: 'a:b.c-d_e', agent: 'f:g.h-i_j', caller: 'a:b.c-d_e/f:g.h-i_j' },
  ],
  // The longest session or agent part the helper accepts, and callerOf produces.
  maxPart: 128,
  // What the helper refuses as a caller, and callerOf never produces.
  notCallers: ['', '/', 'a/', '/a', 'a/b/c', '.a', '_a', '-a', ':a', 'a/.b', 'a b', 'a/b c', '../x', 'a\n', 'ün'],
  // Homes `socketOf` is given, and where the installed helper's socket sits under one.
  home: ['/home/me', '/Users/someone', ''],
  socketUnderHome: '.claude/mcp/codex-cu/run/helper.sock',
}
