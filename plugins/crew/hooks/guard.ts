import { CREW_TYPES, specialistOf } from './agents'

/**
 * Why a crew agent's Write or Edit is refused. Every crew role is read-only and the main session makes every change,
 * so this is the second wall behind the tool allowlists, which leave Write and Edit out. `undefined` lets it through.
 */

/** The agent type without the plugin prefix: `crew:digger` is `digger`. */
const roleOf = (type: string) => type.slice(type.lastIndexOf(':') + 1)

export function deniedWrite(type: string, path: string): string | undefined {
  // Unknown crew types are refused too, including removed roles; another plugin's unknown types stay untouched.
  if (type.startsWith('crew:') && !CREW_TYPES.includes(type)) {
    return `${type} is not a crew agent, so its write to ${path} was not made`
  }
  // The role is the name after the last colon (a `-codex` twin is its base role): another plugin's `acme:digger` is
  // held too.
  const specialist = specialistOf(roleOf(type))
  return specialist && `the ${specialist.name} is read-only, so its write to ${path} was not made; the main session makes changes`
}
