import { NATIVE_SUFFIX, SPECIALISTS } from './agents'

/**
 * Where a crew agent may write. The tool allowlist cannot limit a path, so
 * the entry module asks this before a Write or Edit of an agent that has a
 * rule; `undefined` lets the call through.
 */

// What the agents write lands in the unversioned `.crew/` folder, as Markdown, and never climbs out of it.
const climbs = (path: string) => path.split('/').includes('..')
const isCrewDocument = (path: string) => /(^|\/)\.crew\/.+\.mdx?$/i.test(path) && !climbs(path)

/** The agent type without the plugin prefix: `crew:architect` is `architect`. */
const roleOf = (type: string) => type.slice(type.lastIndexOf(':') + 1)

/**
 * The role whose lane a type follows: a `-codex` twin follows its base role (`crew:architect-codex` is `architect`).
 * The suffix is stripped only when what is left names a specialist; any other suffixed name keeps its own, which no lane knows.
 */
export function laneRole(type: string): string {
  const role = roleOf(type)
  if (!role.endsWith(NATIVE_SUFFIX)) return role
  const base = role.slice(0, -NATIVE_SUFFIX.length)
  return SPECIALISTS.some(specialist => specialist.name === base) ? base : role
}

export function deniedWrite(type: string, path: string): string | undefined {
  const role = laneRole(type)
  // Unknown crew types have no lane, including removed roles; another plugin's unknown types stay untouched.
  if (type.startsWith('crew:') && !SPECIALISTS.some(specialist => type === `crew:${specialist.name}` || type === `crew:${specialist.name}${NATIVE_SUFFIX}`)) {
    return `${type} is not a crew agent with a known lane, so its write to ${path} was not made`
  }
  switch (role) {
    case 'architect':
      return isCrewDocument(path) ? undefined : `the architect writes plan and review documents under .crew/ (.md) only, not ${path}; hand the finding to the developer`
    case 'code-reader':
    case 'research':
    case 'designer':
    case 'developer':
      return undefined
    default:
      return undefined
  }
}
