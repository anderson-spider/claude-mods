import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LANES, laneCwd, laneOf, refusalFor, SANDBOX_POLICY, THREAD } from '../lib/lanes.mjs'

test('the digger, planner and challenger work in the repository; any other role has no lane', () => {
  for (const role of ['digger', 'planner', 'challenger']) {
    assert.equal(laneCwd(role, '/repo'), '/repo', role)
    assert.deepEqual(laneOf(role), {}, role)
  }
  for (const role of ['developer', 'architect', 'auditor', 'qa', '', undefined, 'constructor', '__proto__']) {
    assert.equal(laneOf(role), undefined, String(role))
    assert.equal(laneCwd(role, '/repo'), undefined, String(role))
  }
})

test('a repository that is not an absolute path without .. has no lane cwd', () => {
  for (const repo of ['repo', '', undefined, 3, '/repo/../etc', '/a/../b']) {
    assert.equal(laneCwd('digger', repo), undefined, String(repo))
  }
})

test('the thread never escalates: approvalPolicy never, a workspace-write sandbox on the repository, with the network', () => {
  assert.deepEqual(THREAD, { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'workspace-write', ephemeral: true })
  assert.deepEqual(SANDBOX_POLICY, { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false })
  assert.equal(Object.isFrozen(LANES), true)
  assert.equal(Object.isFrozen(THREAD), true)
})

test('an approval request that still arrives is refused in its own shape; an unknown method has no answer', () => {
  assert.deepEqual(refusalFor('item/commandExecution/requestApproval'), { decision: 'decline' })
  assert.deepEqual(refusalFor('item/fileChange/requestApproval'), { decision: 'decline' })
  assert.deepEqual(refusalFor('item/permissions/requestApproval'), { permissions: {}, scope: 'turn' })
  assert.deepEqual(refusalFor('applyPatchApproval'), { decision: 'denied' })
  assert.deepEqual(refusalFor('execCommandApproval'), { decision: 'denied' })
  assert.equal(refusalFor('account/chatgptAuthTokens/refresh'), undefined)
  assert.equal(refusalFor('something/else'), undefined)
})
