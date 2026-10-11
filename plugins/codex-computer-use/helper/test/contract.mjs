// Examples both halves of the wire contract are checked against: the plugin's
// `callerOf` and `socketOf` (tests/contract.test.ts) and the helper's `isCaller`
// and socket (contract.test.mjs). Types in contract.d.mts.
export const contract = {
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
