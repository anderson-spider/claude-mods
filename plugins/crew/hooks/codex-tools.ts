// The input schemas of the built-in tools a twin on the Codex login may call. The host lists a tool's name and
// description but not its schema, so crew carries these, spelled as the host's own tool inputs are. Pure: no host access.

/** A JSON schema object for one tool's input. */
export type ToolSchema = { type: 'object'; properties: Record<string, unknown>; required: readonly string[]; additionalProperties: false }

const READ: ToolSchema = {
  type: 'object',
  properties: {
    file_path: { type: 'string', description: 'The absolute path to the file to read' },
    offset: { type: 'number', description: 'The line number to start reading from. Only provide if the file is too large to read at once' },
    limit: { type: 'number', description: 'The number of lines to read. Only provide if the file is too large to read at once.' },
    pages: { type: 'string', description: 'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request.' },
  },
  required: ['file_path'],
  additionalProperties: false,
}

const GLOB: ToolSchema = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'The glob pattern to match files against' },
    path: { type: 'string', description: 'The directory to search in. Omit it to use the current working directory; never pass "undefined" or "null".' },
  },
  required: ['pattern'],
  additionalProperties: false,
}

const GREP: ToolSchema = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'The regular expression pattern to search for in file contents' },
    path: { type: 'string', description: 'File or directory to search in (rg PATH). Defaults to current working directory.' },
    glob: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob' },
    output_mode: {
      type: 'string',
      enum: ['content', 'files_with_matches', 'count'],
      description: 'Output mode: "content" shows matching lines, "files_with_matches" shows file paths, "count" shows match counts. Defaults to "files_with_matches".',
    },
    '-B': { type: 'number', description: 'Number of lines to show before each match (rg -B). Requires output_mode: "content".' },
    '-A': { type: 'number', description: 'Number of lines to show after each match (rg -A). Requires output_mode: "content".' },
    '-C': { type: 'number', description: 'Number of lines to show before and after each match (rg -C). Requires output_mode: "content".' },
    '-n': { type: 'boolean', description: 'Show line numbers in output (rg -n). Requires output_mode: "content". Defaults to true.' },
    '-i': { type: 'boolean', description: 'Case insensitive search (rg -i)' },
    type: { type: 'string', description: 'File type to search (rg --type). Common types: js, py, rust, go, java, etc.' },
    head_limit: { type: 'number', description: 'Limit output to first N lines/entries, equivalent to "| head -N". Defaults to 250; 0 for unlimited.' },
    offset: { type: 'number', description: 'Skip first N lines/entries before applying head_limit. Defaults to 0.' },
    multiline: { type: 'boolean', description: 'Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.' },
  },
  required: ['pattern'],
  additionalProperties: false,
}

/** The tools crew can describe to Codex, by the name the model calls them. */
export const TOOL_SCHEMAS: Readonly<Record<string, ToolSchema>> = { Read: READ, Glob: GLOB, Grep: GREP }

/** A twin runs on the Codex login only when every tool it may call has a schema here: Codex cannot call a tool it is not shown. */
export function describable(tools: readonly string[]): boolean {
  return tools.length > 0 && tools.every(tool => Object.hasOwn(TOOL_SCHEMAS, tool))
}
