const ENGINE = {
  type: 'string',
  enum: ['codex', 'claude'],
}

export const EXECUTE = {
  name: 'execute',
  description:
    'Delegates a well-bounded implementation task to an agent (Codex, or Claude with engine: "claude") running in its own Herdr pane ' +
    '(in the current directory; it never commits). Returns a job id at once; when the agent finishes, a message arrives with the report path. ' +
    'One execute runs at a time: the next ones wait in a queue. Write a self-contained task: the goal, the files, the constraints and how to check it.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The whole task, self-contained.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Optional files or folders the agent should start from.' },
      engine: { ...ENGINE, description: 'Optional agent that does the work; codex when absent.' },
    },
    required: ['task'],
  },
}

export const REVIEW = {
  name: 'review',
  description:
    'Has an agent (Codex, or Claude with engine: "claude") review code read-only in its own Herdr pane: the current uncommitted diff, or a branch or commit named in target. ' +
    'Returns a job id at once; when the agent finishes, a message arrives with the report path. Reviews run in parallel.',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Optional branch, commit or range to review; absent, the current uncommitted diff.' },
      focus: { type: 'string', description: 'Optional concern to look at first (races, security, a module).' },
      engine: { ...ENGINE, description: 'Optional agent that reviews; codex when absent.' },
    },
  },
}

export const LOOP = {
  name: 'loop',
  description:
    'Runs dev then read-only QA rounds for a self-contained task, holding the execute queue across all rounds. Returns a loop id at once; ' +
    'one message arrives at the end with the verdict and report path. maxRounds defaults to 3. Use execute and review for manual control.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The whole task, self-contained.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Optional files or folders the dev should start from.' },
      maxRounds: { type: 'integer', minimum: 1, default: 3, description: 'Maximum dev and QA rounds.' },
      devEngine: { ...ENGINE, description: 'Optional agent that develops; codex when absent.' },
      qaEngine: { ...ENGINE, description: 'Optional agent that reviews; codex when absent. A different one from the dev gives an independent review.' },
    },
    required: ['task'],
  },
}

export const JOBS = {
  name: 'jobs',
  description:
    'Lists the jobs and loops of this session (status, pane, report path), reads one by id, or cancels one with action: "cancel". ' +
    'A cancel sends Esc to its active agent, then (Codex only) /stop once it settles, to end the background commands it started. A cancelled standalone job keeps its pane open; a cancelled loop starts no further rounds and closes its panes once the agents stop.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'number', description: 'Optional job or loop id, the number after "ct-" or "loop-" (one shared id space).' },
      action: { type: 'string', enum: ['cancel'], description: 'Optional: cancel the job or loop named by id.' },
    },
  },
}
