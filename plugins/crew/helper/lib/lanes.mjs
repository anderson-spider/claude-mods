// The lane of each role a twin can run as: where its Codex thread may write, and what happens to an approval
// request. The lane is the thread's working directory: Codex keeps its cwd writable, so the sandbox needs no other root.
import { join } from 'node:path'

/**
 * One row per role. `dir` is the thread's cwd below the repository: the developer writes anywhere in the repository,
 * the architect only under `.crew/`. A role with no row is refused (`laneOf` is undefined).
 */
export const LANES = Object.freeze({
  developer: Object.freeze({ dir: '' }),
  architect: Object.freeze({ dir: '.crew' }),
})

export const laneOf = role => (typeof role === 'string' && Object.hasOwn(LANES, role) ? LANES[role] : undefined)

/** The thread's cwd for a role in `repo` (an absolute path), or undefined for an unknown role or a bad repo. */
export const laneCwd = (role, repo) => {
  const lane = laneOf(role)

  if (lane === undefined || typeof repo !== 'string' || !repo.startsWith('/') || repo.split('/').includes('..')) {
    return undefined
  }

  return lane.dir === '' ? repo : join(repo, lane.dir)
}

/** Fixed for every lane: no escalation, no network, nothing writable beyond the thread's cwd, no temp directories. */
export const THREAD = Object.freeze({ approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'workspace-write', ephemeral: true })
export const SANDBOX_POLICY = Object.freeze({
  type: 'workspaceWrite',
  writableRoots: [],
  networkAccess: false,
  excludeTmpdirEnvVar: true,
  excludeSlashTmp: true,
})

/**
 * What crew answers when the server asks for an approval despite `never`: always a refusal, by the method's own shape.
 * An unknown method has no answer (the client replies with an error), which also refuses.
 */
export const refusalFor = method => {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' }
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' }
    case 'applyPatchApproval':
    case 'execCommandApproval':
      return { decision: 'denied' }
    default:
      return undefined
  }
}
