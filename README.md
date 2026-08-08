# loopi

**Pi agent extension for safe, customizable multi-agent loops.**

loopi lets you delegate a task to one or more **coder** agents, then have one or more **reviewer** agents verify the result, and loop again if needed — all without losing control of the main session.

> Not go faster. Go smarter.

---

## What loopi does

The core idea is a structured feedback loop:

1. You describe a goal to the main Pi session.
2. loopi runs **coder agents** to implement the goal.
3. loopi runs **reviewer agents** to inspect the changes.
4. If reviewers request changes, loopi feeds that feedback back to the coders.
5. The loop repeats until the reviewers approve or a max number of rounds is reached.

Each agent runs in its own `pi --mode json -p` subprocess, so every agent gets a fresh, isolated context window. The main Pi session only sees the summarized result.

---

## Repository structure

```text
loopi/
├── README.md                          # This file
├── LICENSE
├── .gitignore
├── package.json                       # Pi package manifest (optional install path)
├── extensions/
│   └── loopi.ts                       # Main extension: registers the `loopi` tool
├── agents/
│   ├── coder.md                       # Default coder agent prompt
│   └── reviewer.md                    # Default reviewer agent prompt
└── docs/
    ├── ARCHITECTURE.md                # Internal design and extension API walkthrough
    ├── pi-custom-tools-guide.md       # General guide to Pi custom tools
    ├── PUBLISHING.md                  # How to publish to npm, install with pi, and develop locally
    └── USAGE.md                       # How to install and use loopi
```

---

## Quick start

### Install as a local Pi package

> Replace `~/loopi` below with wherever you cloned this repository (`$HOME/loopi`, `~/Code/loopi`, `~/projects/loopi`, etc.).

```bash
cd ~/loopi
pi install ./
```

### Or symlink for development

```bash
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/agents
ln -sf ~/loopi/extensions/loopi.ts ~/.pi/agent/extensions/loopi.ts
ln -sf ~/loopi/agents/coder.md ~/.pi/agent/agents/loopi-coder.md
ln -sf ~/loopi/agents/reviewer.md ~/.pi/agent/agents/loopi-reviewer.md
```

### Use it

```text
Use loopi to add input validation to src/api.ts
```

or explicitly:

```text
loopi task="add input validation to src/api.ts" maxRounds=2
```

---

## Design values

- **Transparency first**: every abstraction is heavily commented so you can read the code and collaborate effectively.
- **Composable**: one coder, many coders, one reviewer, many reviewers, parallel or sequential — the structure supports it from day one.
- **Safe**: each agent is isolated in its own subprocess; the main session stays clean.
- **Versioned**: everything lives in git so you can review changes, open PRs, and have other agents inspect the iteration.

---

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the extension works, what each abstraction does, and how to extend it.
- [`docs/USAGE.md`](docs/USAGE.md) — installation, configuration, and everyday commands.
- [`docs/PUBLISHING.md`](docs/PUBLISHING.md) — publishing to npm, installing with `pi`, local development, and running `loopi` side-by-side with `loopi_local`.
- [`docs/pi-custom-tools-guide.md`](docs/pi-custom-tools-guide.md) — general guide to writing Pi custom tools.

---

## Status

This is the first iteration. Expect the core loop to work end-to-end, with room for richer orchestration (parallel reviewers, reviewer voting, structured verdicts, plan/review/execute stages) in upcoming PRs.
