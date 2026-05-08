# Pi MCP Adapter: Development Instructions

This repository is a personal fork at `github.com/ghul0/pi-mcp-adapter`. The original upstream repository is `github.com/nicobailon/pi-mcp-adapter`.

## Branch and Remote Workflow

**Remotes:**
- `origin` → `git@github.com:ghul0/pi-mcp-adapter.git` (your fork; push + pull)
- `upstream` → `git@github.com:nicobailon/pi-mcp-adapter.git` (original; read-only)

**Branches:**
- `main` — clean mirror of `upstream/main`. Never commit here directly.
- `develop` — working branch for local modifications. Always rebase this branch on top of fresh `main`.
- Existing `feat/*` branches may remain for isolated work or worktrees, but the default day-to-day branch is `develop`.

## Session-start Sync

At the beginning of every session, sync `main` from upstream, then rebase `develop` on top of it.

```bash
git fetch upstream --tags
git checkout main
git merge --ff-only upstream/main
git push origin main
git checkout develop
git rebase main
git push --force-with-lease origin develop
```

If `git merge --ff-only upstream/main` fails, stop and investigate before making changes.

## Daily Work

Do normal development on `develop` unless a task specifically needs an isolated feature branch.

```bash
git checkout develop
# ... edit, test, commit ...
git push origin develop
```

## Current Develop Composition

`develop` currently contains these two feature commits on top of `main`:
- `7c28cca` — support multiple `--mcp-config` files with ordered merge
- `d8e788f` — add MCP policy layer with startup validation
