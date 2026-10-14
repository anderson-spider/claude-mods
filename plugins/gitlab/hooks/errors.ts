// What an API refusal tells the model: GitLab's status and message, then what to do about it.
import type { GitlabError } from './api'

/** A hint for the status (and, for 403, whether the request wrote), or undefined when GitLab's message says enough. */
export function hint(err: GitlabError, project: string, host: string): string | undefined {
  switch (err.status) {
    case 401:
      return `The token for ${host} was refused (expired or revoked?). Replace it in the plugin options (/plugin, gitlab, configure).`
    case 403:
      return err.method === 'GET'
        ? `The token's user may have no access to ${project}.`
        : `The token may lack the api scope (read_api only reads), or the user's role in ${project} does not allow this.`
    case 404:
      return `${project} may not exist or the token's user cannot see it; check the project path and the iid or id.`
    case 405:
    case 406:
      return 'GitLab refused the action in the current state (for a merge: not mergeable yet, or merging is not allowed).'
    case 409:
      return 'Something changed meanwhile (for a merge: the head moved; read status again).'
    default:
      return undefined
  }
}

export function errorText(err: GitlabError, project: string, host: string): string {
  const more = hint(err, project, host)
  const said = err.message.replace(/[.\s]+$/, '')
  return `GitLab answered ${err.status} for ${project}: ${said}${more ? `. ${more}` : ''}`
}
