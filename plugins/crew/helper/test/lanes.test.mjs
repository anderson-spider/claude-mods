import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LANES, laneCwd, laneOf, refusalFor, SANDBOX_POLICY, THREAD } from '../lib/lanes.mjs'

test('the developer works in the repository and the architect only in .crew; any other role has no lane', () => {
  assert.equal(laneCwd('developer', '/repo'), '/repo')
  assert.equal(laneCwd('architect', '/repo'), '/repo/.crew')
  for (const role of ['designer', 'research', 'code-reader', '', undefined, 'constructor', '__proto__']) {
    assert.equal(laneOf(role), undefined, String(role))
    assert.equal(laneCwd(role, '/repo'), undefined, String(role))
  }
})

test('a repository that is not an absolute path without .. has no lane cwd', () => {
  for (const repo of ['repo', '', undefined, 3, '/repo/../etc', '/a/../b']) {
    assert.equal(laneCwd('developer', repo), undefined, String(repo))
    assert.equal(laneCwd('architect', repo), undefined, String(repo))
  }
})

test('the thread never escalates: approvalPolicy never, workspace-write, no network, no roots beyond the cwd, no temp dirs', () => {
  assert.deepEqual(THREAD, { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'workspace-write', ephemeral: true })
  assert.deepEqual(SANDBOX_POLICY, { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true })
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
