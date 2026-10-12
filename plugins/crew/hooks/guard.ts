import { NATIVE_SUFFIX, SPECIALISTS } from './agents'

/**
 * Where a crew agent may write. The tool allowlist cannot limit a path, so
 * the entry module asks this before a Write or Edit of an agent that has a
 * rule; `undefined` lets the call through.
 */

// A test file by name or by folder, across the stacks this repository's owner uses.
const TEST_PATH = [
  /(^|\/)(tests?|__tests__|specs?|androidTest|testFixtures)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]*$/,
  /_test\.[a-z]+$/,
  /Tests?\.(kt|java|swift|cs)$/,
]

const isTestFile = (path: string) => TEST_PATH.some(rule => rule.test(path))

// What the agents write lands in the unversioned `.crew/` folder, as Markdown, and never climbs out of it.
const climbs = (path: string) => path.split('/').includes('..')
const isCrewDocument = (path: string) => /(^|\/)\.crew\/.+\.mdx?$/i.test(path) && !climbs(path)

// The tester's reports go to the reviews folder, as Markdown.
const isReviewDocument = (path: string) => /(^|\/)\.crew\/reviews\/.+\.mdx?$/i.test(path)

/** The agent type without the plugin prefix: `crew:tester` is `tester`. */
const roleOf = (type: string) => type.slice(type.lastIndexOf(':') + 1)

/**
 * The role whose lane a type follows: a `-codex` twin follows its base role (`crew:tester-codex` is `tester`).
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
  // A crew type with the twin suffix whose base is no specialist has no lane: its writes are held, not allowed.
  if (type.startsWith('crew:') && role.endsWith(NATIVE_SUFFIX)) {
    return `${type} is not a crew agent with a known lane, so its write to ${path} was not made`
  }
  switch (role) {
    case 'architect':
      return isCrewDocument(path) ? undefined : `the architect writes plan and review documents under .crew/ (.md) only, not ${path}; hand the finding to the developer`
    case 'tester':
      return !climbs(path) && (isTestFile(path) || isReviewDocument(path))
        ? undefined
        : `the tester writes test files and reports under .crew/reviews/ (.md) only, not ${path}; hand the failure back with the evidence` +
            (climbs(path) ? '; a `..` segment is refused' : '')
    default:
      return undefined
  }
}
