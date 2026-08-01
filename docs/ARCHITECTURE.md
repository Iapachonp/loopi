# loopi Architecture

This document explains how the loopi extension is structured, what each abstraction is responsible for, and how to extend it.

---

## Overview

loopi is a Pi extension. Pi discovers it as a TypeScript file in the extensions directory. When Pi loads the file, it calls the default exported factory function with an `ExtensionAPI` object. The factory registers one custom tool named `loopi`. When the main Pi model calls that tool, the extension spawns child `pi` processes to do the actual work.

```text
+-----------------------------------+
| Main Pi session (user's terminal) |
| Model calls `loopi` tool          |
+-----------------------------------+
              |
              v
+-----------------------------------+
| loopi.ts::execute()               |
|  - discovers agents               |
|  - runs coder agent               |
|  - runs reviewer agent            |
|  - loops if needed                |
+-----------------------------------+
              |
              v
+-----------------------------------+
| Child pi processes                |
|  pi --mode json -p --no-session   |
|  with isolated context windows    |
+-----------------------------------+
```

---

## Key abstractions

### `AgentConfig`

An in-memory representation of an agent definition markdown file.

- `name` — unique identifier.
- `description` — human-readable purpose.
- `tools` — optional list of tool names exposed to the child agent.
- `model` — optional model override.
- `filePath` — absolute path to the markdown definition.

The markdown files live in `agents/` and have YAML frontmatter plus a body that becomes the child agent's system prompt.

### `discoverAgents(cwd)`

Finds agent definitions from:

1. `~/.pi/agent/agents/*.md` (global, personal/team defaults)
2. `<cwd>/.pi/agents/*.md` (project-local)

Project-local agents override global agents with the same name.

This lets you ship repo-specific agents by committing them to `.pi/agents/` inside the project.

### `runAgent(cwd, agent, task, signal)`

The subprocess runner. It:

1. Writes the agent's system prompt body to a temp file.
2. Spawns a child `pi --mode json -p --no-session` process.
3. Optionally passes `--model` and `--tools` based on the agent config.
4. Passes the task as the final CLI argument.
5. Parses the JSONL event stream from stdout.
6. Returns the final assistant text, all messages, exit code, and stderr.

`--mode json -p --no-session` is the headless Pi mode. It does not save a session file and prints one JSON event per line. We listen for `message_end` events to reconstruct the assistant output.

### `buildCoderTask(...)` / `buildReviewerTask(...)`

These functions format the prompt that is passed to the child process. They are the boundary where the main loop composes context for each agent.

- Coder task includes the original task plus any previous reviewer feedback.
- Reviewer task includes the original task plus the coder output.

### `parseVerdict(...)`

A simple, explicit contract parser. It scans reviewer outputs for the exact keywords `APPROVED` or `CHANGES_REQUESTED`.

This is intentionally simple in v0.1. Future versions may use JSON schema outputs from agents, but explicit keywords are easy to inspect and debug.

### `loopi` tool

The public surface. The model sees it in its system prompt and can call it with:

```json
{
  "task": "add input validation to src/api.ts",
  "maxRounds": 2,
  "coderAgent": "loopi-coder",
  "reviewerAgent": "loopi-reviewer"
}
```

The tool orchestrates the loop and returns a final summary to the main model.

---

## Data flow of one loop

1. User asks Pi: "Use loopi to add input validation to src/api.ts".
2. Main model calls `loopi` tool with `task` parameter.
3. `execute()` discovers agents and resolves `loopi-coder` + `loopi-reviewer`.
4. Round 1:
   - `runCoderRound(...)` spawns coder subprocess with task.
   - Coder edits files, returns summary.
   - `runReviewerRound(...)` spawns reviewer subprocess with original task + coder summary.
   - Reviewer returns verdict.
5. If `APPROVED`, loopi returns success to main model.
6. If `CHANGES_REQUESTED`, loopi feeds the feedback back to the coder and starts round 2.
7. If max rounds is reached without approval, loopi reports that and stops.

---

## Why child processes?

Each child `pi` process has its own context window. Running agents as children keeps the main Pi session clean and avoids polluting it with every file read and intermediate thought from the coder/reviewer.

This is the same approach used by Pi's official `subagent` example extension.

---

## Extension points (future PRs)

| Feature | Where to add | Notes |
|---|---|---|
| Multiple coders in parallel | `execute()` round logic | Map over `coderAgents` with `Promise.all`. |
| Multiple reviewers / voting | `parseVerdict()` | Aggregate multiple verdicts instead of one. |
| Parallel strategy enum | `LoopiParams` schema + `StringEnum` | `"sequential"`, `"parallel"`. |
| Structured JSON verdicts | Agent prompts + `parseVerdict()` | Use a terminating structured-output schema. |
| Plan/execute/review stages | Add a `planner` agent | Run planner before coders. |
| Usage/cost tracking | `AgentResult` + child message usage | Parse `message_end` `usage` field. |
| Custom agent directories | `discoverAgents()` | Accept additional paths from settings. |
| Retry on child spawn failure | `runAgent()` | Catch spawn errors and retry once. |

---

## Safety and good practices already in place

- `withFileMutationQueue()` is used when writing temp prompt files.
- The parent `AbortSignal` is wired to child processes so cancellation propagates.
- Temp files are cleaned up in a `finally` block.
- Output is not yet truncated because child agents are responsible for their own truncation via Pi's built-in limits; we may add explicit truncation later.
- Clear error messages when agents are missing.

---

## How to read the code

Start with `extensions/loopi.ts` and follow the table of contents at the top. The file is split into numbered sections:

1. Imports
2. Constants
3. Types
4. Agent discovery
5. Subprocess plumbing
6. Round orchestration
7. Tool registration
8. Default export

Each function has a JSDoc block explaining its responsibility and the reason behind its design choices.
