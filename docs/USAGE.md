: "loopi"

This guide shows how to install loopi and use it day-to-day.

---

## Install loopi

### Option A: install as a local Pi package (recommended for first use)

```bash
cd /home/ivan/Code/loopi
pi install ./
```

This adds the package to `~/.pi/agent/settings.json` and loads the extension + agents automatically.

### Option B: symlink for active development

If you are changing loopi code frequently, symlink the files so `/reload` picks up edits immediately:

```bash
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/agents
ln -sf /home/ivan/Code/loopi/extensions/loopi.ts ~/.pi/agent/extensions/loopi.ts
ln -sf /home/ivan/Code/loopi/agents/coder.md ~/.pi/agent/agents/loopi-coder.md
ln -sf /home/ivan/Code/loopi/agents/reviewer.md ~/.pi/agent/agents/loopi-reviewer.md
```

After editing, run `/reload` in Pi.

### Option C: install from git (once published)

```bash
pi install git:github.com/ivan/loopi@v0.1.0
```

---

## Basic usage

Start Pi in the project where you want the agents to work:

```bash
cd /path/to/your-project
pi
```

Then ask:

```text
Use loopi to add input validation to src/api.ts
```

The main model will call the `loopi` tool with a default `maxRounds` of 2.

### Explicit parameters

You can call the tool directly:

```text
loopi task="refactor auth middleware into its own file" maxRounds=3
```

### Parameters

| Parameter | Default | Description |
|---|---|---|
| `task` | required | What the coder agents should do. |
| `maxRounds` | 2 | Maximum coder/reviewer rounds. |
| `coderAgent` | `loopi-coder` | Name of the coder agent definition to use. |
| `reviewerAgent` | `loopi-reviewer` | Name of the reviewer agent definition to use. |

---

## Customizing agents

### Edit the default agents

Modify the markdown files in `agents/`:

- `agents/coder.md` — instructions for the coder.
- `agents/reviewer.md` — instructions for the reviewer.

After editing, run `/reload` (or reinstall if using `pi install`).

### Add a new agent

1. Create a new file in `agents/`, e.g. `agents/strict-reviewer.md`:

```markdown
---
name: strict-reviewer
description: Extra strict reviewer for critical code
tools: read, bash, grep, find, ls
model: claude-sonnet-4-5
---

You are an extremely strict reviewer...

## Verdict
`APPROVED` or `CHANGES_REQUESTED`
```

2. If using symlinks, link it:

```bash
ln -sf /home/ivan/Code/loopi/agents/strict-reviewer.md ~/.pi/agent/agents/strict-reviewer.md
```

3. Use it:

```text
loopi task="secure the login endpoint" reviewerAgent="strict-reviewer"
```

### Project-local agents

For repo-specific behavior, create `.pi/agents/` inside the project:

```text
your-project/
├── .pi/
│   └── agents/
│       └── loopi-coder.md
└── src/
```

Project-local agents override global agents with the same name.

---

## Troubleshooting

### "Coder agent 'loopi-coder' not found"

The extension cannot find the agent markdown file. Check that:

- `agents/coder.md` exists and has `name: loopi-coder` in its frontmatter.
- The file is installed/symlinked into `~/.pi/agent/agents/` or `.pi/agents/`.
- You ran `/reload` after adding it.

### Child process exits with code 1

Open the tool result details (Ctrl+O in TUI) to see the stderr. Common causes:

- Missing API key for the model specified in the agent.
- Invalid `--tools` list in the agent frontmatter.
- Agent tried to use a tool it does not have access to.

### Loop never approves

- Make the task more specific.
- Increase `maxRounds`.
- Tighten the reviewer prompt so it returns clear `APPROVED`/`CHANGES_REQUESTED` keywords.

---

## Development workflow

1. Make changes in `/home/ivan/Code/loopi`.
2. Run `/reload` in Pi if using symlinks, or `pi install ./` again if using the package path.
3. Test with a small, safe task in a git-tracked project so you can inspect diffs.
4. Commit and push:

```bash
cd /home/ivan/Code/loopi
git add .
git commit -m "describe change"
git push origin feat/initial-extension
```

5. Open a PR. The reviewer agent (human or another Pi) can inspect the diff and the docs.
