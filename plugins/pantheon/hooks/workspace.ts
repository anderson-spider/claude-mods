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
    if (!realRoot?.startsWith('/')) return { error: `Não foi possível resolver a raiz autorizada: ${root}` }
    const realCwd = await statReal(cwd)
    if (!realCwd?.startsWith('/')) return { error: `Não foi possível resolver cwd: ${cwd}` }
    const resolvedRoot = withoutTrailingSlash(realRoot)
    const resolvedCwd = withoutTrailingSlash(realCwd)
    const prefix = resolvedRoot === '/' ? '/' : `${resolvedRoot}/`
    if (resolvedCwd !== resolvedRoot && !resolvedCwd.startsWith(prefix)) {
      return { error: `cwd ${resolvedCwd} está fora da raiz autorizada ${resolvedRoot}` }
    }
    return resolvedCwd
  } catch (error) {
    return { error: `Não foi possível resolver o workspace: ${error instanceof Error ? error.message : String(error)}` }
  }
}
