---
name: brainstorm
description: Use when the person wants to explore or shape an idea before building it (a feature, a refactor, a behavior change, "what if", "how should we"), before any plan or code exists. Ends with the idea defined in writing, not with work started.
---

# Brainstorm

Turn an idea into a defined one the person has agreed to. This skill writes no code, no plan file, no worktree and no flow.

## 1. Understand

- Read before asking: code-reader for code, docs-reader for external docs, in parallel when both apply. Do not ask what they already answer.
- If the idea holds several independent pieces, name them and work on the first one.

## 2. Explore

- Put two or three approaches on the table with their trade-offs (cost, risk, how hard to undo, fit with the code). Recommend one and give the reason. If only one approach makes sense, say so instead of inventing others.
- Ask one question at a time, your recommendation first. Revisit an answer when a new fact changes it.

## 3. Converge

- Write the idea back in a few lines: purpose, decisions taken, constraints, and how each part will be verified (a command, a test, a visible result). Say what you assumed.
- Wait for a correction or a yes. Stop asking once purpose, constraints and success criteria are clear.

## 4. Stop

- Do not start the work. Tell the person the idea is defined, and that `/pantheon:goal` starts the flow from this conversation, or `/pantheon:goal <goal text>` starts it from a sentence they write.
