import { CREW_TYPES, LANES, specialistOf } from './agents'
import type { Lane } from './agents'

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
  return specialistOf(role)?.name ?? role
}

/** The rule of each lane: why a write to `path` by the `role` is refused, or `undefined`. A lane without a rule fails to compile. */
const LANE_RULES: Record<Lane, (role: string, path: string) => string | undefined> = {
  unrestricted: () => undefined,
  'crew-documents': (role, path) =>
    isCrewDocument(path) ? undefined : `the ${role} writes plan and review documents under .crew/ (.md) only, not ${path}; hand the finding to the developer`,
}

export function deniedWrite(type: string, path: string): string | undefined {
  // Unknown crew types have no lane, including removed roles; another plugin's unknown types stay untouched.
  if (type.startsWith('crew:') && !CREW_TYPES.includes(type)) {
    return `${type} is not a crew agent with a known lane, so its write to ${path} was not made`
  }
  // The lane follows the role name after the last colon, so another plugin's `acme:architect` follows the architect's.
  const specialist = specialistOf(roleOf(type))
  return specialist && LANE_RULES[LANES[specialist.name]](specialist.name, path)
}
