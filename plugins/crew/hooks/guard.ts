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

export function deniedWrite(type: string, path: string): string | undefined {
  switch (roleOf(type)) {
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
