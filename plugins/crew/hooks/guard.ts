import { CREW_TYPES } from './agents'

/**
 * Why a crew agent's Write or Edit is refused. Every crew role may write when its request asks, so only a `crew:` type
 * that is not a role is held: a removed role or a misspelled one. `undefined` lets it through.
 */
export function deniedWrite(type: string, path: string): string | undefined {
  // Another plugin's types stay untouched.
  if (type.startsWith('crew:') && !CREW_TYPES.includes(type)) {
    return `${type} is not a crew agent, so its write to ${path} was not made`
  }
  return undefined
}
