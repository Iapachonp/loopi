# Publishing, Installing, and Developing loopi

This guide covers how to publish `loopi` to npm, install it with `pi`, develop it locally, and keep a stable npm version alongside a local development copy.

---

## Table of contents

1. [Publish to npm](#publish-to-npm)
2. [Install with pi](#install-with-pi)
3. [Develop locally](#develop-locally)
4. [Side-by-side: official npm loopi + loopi-local](#side-by-side-official-npm-loopi--loopi-local)
5. [Troubleshooting](#troubleshooting)

---

## Publish to npm

### 1. Make sure the package is ready

Check `package.json`:

```json
{
  "name": "loopi",
  "version": "0.1.0",
  "description": "Pi extension for safe multi-agent coder/reviewer loops",
  "keywords": ["pi-package"],
  "license": "MIT",
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "typebox": "*"
  },
  "pi": {
    "extensions": ["./extensions"],
    "agents": ["./agents"]
  }
}
```

> If you want a scoped name (e.g. `@your-org/loopi`), change `name` now. Scoped packages require an npm account with the matching scope.

### 2. Choose a version

Use [SemVer](https://semver.org/):

- `0.1.0` → first public release
- `0.2.0` → new feature, backward compatible
- `0.2.1` → bugfix only
- `1.0.0` → stable API

Update both `package.json` and `package-lock.json`:

```bash
npm version 0.1.0
```

This bumps both files and creates a git tag.

### 3. Build and pack (optional but recommended)

Because Pi extensions are TypeScript executed directly by [jiti](https://github.com/unjs/jiti), no build step is required. Still, verify the package contents with:

```bash
npm pack
```

This creates `loopi-0.1.0.tgz`. Inspect it to confirm it includes:

```text
extensions/loopi.ts
agents/coder.md
agents/reviewer.md
package.json
LICENSE
README.md
```

> `node_modules/` is excluded by the existing `.gitignore` rules, which `npm pack` respects.

### 4. Log in to npm

```bash
npm login
```

For scoped packages, also ensure you have publish access:

```bash
npm access public  # if publishing a scoped public package
```

### 5. Publish

```bash
npm publish
```

For a scoped package with public access:

```bash
npm publish --access public
```

After publishing, verify on `https://www.npmjs.com/package/loopi` (or `https://www.npmjs.com/package/@your-org/loopi`).

### 6. Push the version tag to git

```bash
git push origin main
git push origin v0.1.0
```

---

## Install with pi

Once `loopi` is on npm, anyone can install it with Pi's package manager.

### From npm

```bash
pi install npm:loopi@0.1.0
```

Or the latest version:

```bash
pi install npm:loopi
```

### From git (no npm account required)

```bash
pi install git:github.com/<your-github-username>/loopi@v0.1.0
```

### What `pi install` does

Pi will:

1. Download the package into `~/.pi/agent/npm/loopi/` (for npm) or `~/.pi/agent/git/github.com/<you>/loopi/` (for git).
2. Run `npm install` if a `package.json` exists.
3. Read the `pi` manifest and register `extensions/` and `agents/`.
4. Write the dependency into `~/.pi/agent/settings.json`.

### Verify it loaded

Start Pi and run:

```text
/tools
```

Look for `loopi` in the tool list.

Then try:

```text
Use loopi to add input validation to src/api.ts
```

---

## Develop locally

For fast iteration, you usually do **not** want to publish to npm every time you change a file. Use one of these local workflows.

### Option A: install from the local directory

```bash
cd ~/loopi
pi install ./
```

Pi copies/installs the package into `~/.pi/agent/npm/loopi/`.

Pros: matches the npm install flow.  
Cons: changes in the repo are **not** picked up automatically. Run `pi install ./` again after edits.

### Option B: symlink for live development (recommended)

This is the fastest loop. Edits in `~/loopi` are reflected immediately after `/reload` in Pi.

```bash
# 1. Create Pi's global directories if they don't exist
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/agents

# 2. Symlink the extension and agent files
ln -sf ~/loopi/extensions/loopi.ts ~/.pi/agent/extensions/loopi.ts
ln -sf ~/loopi/agents/coder.md ~/.pi/agent/agents/loopi-coder.md
ln -sf ~/loopi/agents/reviewer.md ~/.pi/agent/agents/loopi-reviewer.md
```

> Replace `~/loopi` with your actual clone directory (`$HOME/loopi`, `~/Code/loopi`, etc.).

After editing any file, run `/reload` in Pi to pick up changes.

### Option C: project-local development

If you are building a feature **for a specific repo**, put the extension directly inside that repo:

```text
your-project/
├── .pi/
│   └── extensions/
│       └── loopi.ts
```

Pi will load it after you trust the project. This is useful for testing changes in a real codebase without touching global Pi config.

### Testing before publishing

```bash
# Pack the package locally
npm pack

# Inspect the tarball contents
tar -tzf loopi-0.1.0.tgz
```

Make sure `extensions/loopi.ts` and `agents/*.md` are included. If they are missing, check `.gitignore` and add an `files` field to `package.json`:

```json
{
  "files": [
    "extensions/",
    "agents/",
    "docs/",
    "README.md",
    "LICENSE"
  ]
}
```

---

## Side-by-side: official npm loopi + loopi-local

A common setup is:

- `loopi` — the stable version from npm, for real work.
- `loopi-local` — a renamed local copy for development, so you can test changes without breaking the stable tool.

### Step 1: rename the local tool

Edit `extensions/loopi.ts` and change the registered tool name:

```typescript
pi.registerTool({
  name: "loopi_local",        // was "loopi"
  label: "loopi (local dev)",   // was "loopi"
  // ... rest unchanged
});
```

Also change the agent names in `agents/*.md` frontmatter so they don't collide:

#### `agents/coder.md`

```yaml
---
name: loopi-local-coder        # was loopi-coder
---
```

#### `agents/reviewer.md`

```yaml
---
name: loopi-local-reviewer     # was loopi-reviewer
---
```

### Step 2: update the extension to reference the new agent names

In `extensions/loopi.ts`, find the default agent names and update them:

```typescript
coderAgent: params.coderAgent ?? "loopi-local-coder",
reviewerAgent: params.reviewerAgent ?? "loopi-local-reviewer",
```

### Step 3: symlink with new file names

```bash
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/agents
ln -sf ~/loopi/extensions/loopi.ts ~/.pi/agent/extensions/loopi-local.ts
ln -sf ~/loopi/agents/coder.md ~/.pi/agent/agents/loopi-local-coder.md
ln -sf ~/loopi/agents/reviewer.md ~/.pi/agent/agents/loopi-local-reviewer.md
```

### Step 4: keep this dev-only rename out of git

Add a local-only config file to prevent accidentally committing the renamed extension:

```bash
# Add these patterns so git ignores dev-mode generated files
# Already covered by .gitignore: node_modules, *.tgz
```

Better yet, do the rename on a dedicated branch and never merge it:

```bash
git checkout -b local-dev
# edit name + agent names
# symlink + test
```

### Step 5: use both tools

Stable version:

```text
Use loopi to refactor auth middleware
```

Local dev version:

```text
Use loopi_local to refactor auth middleware
```

### Reverting to publish

Before publishing or opening a PR, switch back to `main` (or revert the rename):

```bash
git checkout main
# or
git checkout -- extensions/loopi.ts agents/coder.md agents/reviewer.md
```

Confirm the published package still registers `loopi`, not `loopi_local`.

---

## Troubleshooting

### `pi install npm:loopi` cannot find the package

- Wait a minute after `npm publish`; the registry can be briefly out of sync.
- Check the package name and version on npmjs.com.
- If scoped, make sure it is public (`npm publish --access public`).

### `/tools` does not show `loopi`

- Run `/reload` in Pi.
- Check `~/.pi/agent/settings.json` for the installed package.
- Verify the symlink targets exist (`ls -la ~/.pi/agent/extensions/loopi.ts`).

### `loopi_local` collides with stable `loopi`

The two tools must have different `name` values in `registerTool({ name: ... })`. Pi uses that `name` as the tool identifier.

### Local changes not picked up

- If using `pi install ./`, reinstall: `pi install ./`.
- If using symlinks, run `/reload` in Pi.
- Pi caches extension state per session; a fresh Pi session also helps.

### `npm pack` is missing files

Add an explicit `files` array to `package.json` (see [Testing before publishing](#testing-before-publishing)).

---

## Quick command reference

| Task | Command |
|---|---|
| Bump version | `npm version 0.1.0` |
| Pack locally | `npm pack` |
| Publish | `npm publish` |
| Install stable in Pi | `pi install npm:loopi@0.1.0` |
| Install from git in Pi | `pi install git:github.com/<you>/loopi@v0.1.0` |
| Install local directory in Pi | `pi install ./` |
| Symlink for dev | `ln -sf ~/loopi/extensions/loopi.ts ~/.pi/agent/extensions/loopi.ts` |
| Reload after edits | `/reload` inside Pi |
