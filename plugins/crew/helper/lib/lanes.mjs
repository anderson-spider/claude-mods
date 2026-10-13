// The roles a twin can run as, and the fixed thread and sandbox settings. The lane is the thread's working directory,
// the repository, in Codex's read-only sandbox: nothing is writable, the cwd included, and the network is off.

/** One row per role. A role with no row is refused (`laneOf` is undefined). */
export const LANES = Object.freeze({
  digger: Object.freeze({}),
  planner: Object.freeze({}),
  challenger: Object.freeze({}),
})

export const laneOf = role => (typeof role === 'string' && Object.hasOwn(LANES, role) ? LANES[role] : undefined)

/** The thread's cwd for a role in `repo` (an absolute path), or undefined for an unknown role or a bad repo. */
export const laneCwd = (role, repo) => {
  if (laneOf(role) === undefined || typeof repo !== 'string' || !repo.startsWith('/') || repo.split('/').includes('..')) {
    return undefined
  }

  return repo
}

/** Fixed for every lane: no escalation, no network, nothing writable. */
export const THREAD = Object.freeze({ approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only', ephemeral: true })
export const SANDBOX_POLICY = Object.freeze({ type: 'readOnly', networkAccess: false })

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
