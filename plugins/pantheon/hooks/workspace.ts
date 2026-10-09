import type { StatReal } from './types'

export function authorizedRoot(sessionCwd: string, gitTopLevel: string | undefined): string {
  return gitTopLevel ?? sessionCwd
}

function withoutTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '') || '/'
}

export async function checkCwd(statReal: StatReal, root: string, cwd: string): Promise<string | { error: string }> {
  try {
    const realRoot = await statReal(root)
    if (!realRoot?.startsWith('/')) return { error: `Could not resolve the authorized root: ${root}` }
    const realCwd = await statReal(cwd)
    if (!realCwd?.startsWith('/')) return { error: `Could not resolve cwd: ${cwd}` }
    const resolvedRoot = withoutTrailingSlash(realRoot)
    const resolvedCwd = withoutTrailingSlash(realCwd)
    const prefix = resolvedRoot === '/' ? '/' : `${resolvedRoot}/`
    if (resolvedCwd !== resolvedRoot && !resolvedCwd.startsWith(prefix)) {
      return { error: `cwd ${resolvedCwd} is outside the authorized root ${resolvedRoot}` }
    }
    return resolvedCwd
  } catch (error) {
    return { error: `Could not resolve the workspace: ${error instanceof Error ? error.message : String(error)}` }
  }
}
