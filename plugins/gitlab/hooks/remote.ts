// Which GitLab the session's repository lives on. Pure: git is injected.

/** Runs `git <args>` in the session's directory. */
export type Git = (args: string[]) => Promise<{ exitCode: number; stdout: string }>

export type Location = { host: string; project: string }

/** A host name (an https remote may carry a port): what may follow `https://` without changing the host. */
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/
/** `group/sub/project`: at least two segments of GitLab path characters, no dot-only segment. */
const PROJECT = /^[\w.-]+(\/[\w.-]+)+$/

/**
 * The host and project path of a remote URL: `git@host:group/proj.git`, `ssh://git@host:22/group/proj.git` or
 * `https://host/group/proj.git`. An SSH port is dropped (the API is https); an https port is kept.
 */
export function parseRemote(url: string): Location | undefined {
  const text = url.trim()
  let host: string
  let path: string
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let parsed: URL
    try {
      parsed = new URL(text)
    } catch {
      return undefined
    }
    const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
    if (scheme === 'https' || scheme === 'http') host = parsed.host
    else if (scheme === 'ssh' || scheme === 'git+ssh') host = parsed.hostname
    else return undefined
    path = decodeURIComponent(parsed.pathname)
  } else if (scp) {
    host = scp[1]!
    path = scp[2]!
  } else {
    return undefined
  }
  host = host.toLowerCase()
  const project = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '')
  if (!HOST.test(host) || !PROJECT.test(project) || project.split('/').some((s) => /^\.+$/.test(s))) return undefined
  return { host, project }
}

export const NO_REMOTE =
  'This directory is not a git repository with a GitLab remote. Run the tool from a repository whose origin is on GitLab.'

/** The `origin` remote, or the first remote when there is no `origin`. */
export async function locate(git: Git): Promise<Location | { error: string }> {
  let url = await git(['remote', 'get-url', 'origin']).catch(() => undefined)
  if (!url || url.exitCode !== 0) {
    const names = await git(['remote']).catch(() => undefined)
    const first = names?.exitCode === 0 ? names.stdout.split('\n').map((s) => s.trim()).find(Boolean) : undefined
    if (!first) return { error: NO_REMOTE }
    url = await git(['remote', 'get-url', first]).catch(() => undefined)
    if (!url || url.exitCode !== 0) return { error: NO_REMOTE }
  }
  const where = parseRemote(url.stdout)
  // the URL itself is not echoed: an https remote may carry a user and password
  return where ?? { error: 'The git remote is not a GitLab project URL this plugin can read (host and group/project).' }
}

/** The checked-out branch, or undefined on a detached HEAD or outside a repository. */
export async function currentBranch(git: Git): Promise<string | undefined> {
  const out = await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => undefined)
  const name = out?.exitCode === 0 ? out.stdout.trim() : ''
  return name && name !== 'HEAD' ? name : undefined
}
