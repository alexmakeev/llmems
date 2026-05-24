# CLAUDE.md — llmems

`@alexmakeev/llmems` is a TypeScript long-term memory library for LLM agents: conversations are
broken into chunks, summarized into atomic Zettelkasten-style "mems" with embeddings, and recalled
into the model's context on each new message. Storage backends: in-memory and PostgreSQL + pgvector.

## Build & Test

```bash
npm run build      # compile TypeScript → dist/ (runs `tsc`)
npm test           # run the test suite with vitest (no external services required)
```

CI (`.github/workflows/ci.yml`) runs `npm ci` → `npm run build` → `npm test` on Node.js 22 for
every push and pull request to `main`. Keep tests green before committing.

## Release Process

Publishing is automated via tag push — **never run `npm publish` manually.** The
`.github/workflows/publish.yml` workflow fires on any `v*` tag pushed to the repository and runs
install → build → test → `npm publish` to GitHub Packages (`https://npm.pkg.github.com`).

To cut a new release `X.Y.Z`:

1. Bump `version` in `package.json` to `X.Y.Z`.
2. Add a new top section to `CHANGELOG.md` describing the changes.
3. Commit the changes to `main`.
4. Push `main`: `git push origin main`.
5. Create an annotated tag: `git tag -a vX.Y.Z -m "release vX.Y.Z"`.
6. Push the tag: `git push origin vX.Y.Z`.
7. The `publish.yml` workflow publishes the package automatically.

Rules:

- Publishing is automated via tag push. Never run `npm publish` manually.
- `origin` (GitHub, `git@github.com:alexmakeev/llmems.git`) is the canonical remote.
- Never push to `gitea` — it is a diverged remote and must not receive any pushes.

## Git

- `origin` is canonical. `gitea` is a diverged remote — do not push to it.
- Releases flow through `main` + a `vX.Y.Z` tag (see Release Process).

## Repository Topology — llmems ↔ Altme

### llmems library (this repo)
- Canonical remote: `origin` = `git@github.com:alexmakeev/llmems.git` (GitHub). Only remote — `gitea` remote was removed 2026-05-23.
- Publishes to GitHub Packages (`npm.pkg.github.com`), scope `@alexmakeev`, package `@alexmakeev/llmems`.
- CD: `.github/workflows/publish.yml` triggers on `v*` tag push → CI → `npm publish` (GitHub Packages, `secrets.GITHUB_TOKEN`). Never run `npm publish` manually.
- Local layout: bare repo at `/home/alexmak/llmems/` + git worktrees inside it.

### Altme bot ("Altbot") — separate project
- **Separate repo**: `gitea.oneln.ru`, org `llm-agents`, repo `altme-bot` (altme-bot.git).
- DEV/PROD deploy from that repo via Dokploy — NOT from any local `~/llmems/` directory.
- llmems is a **library consumed by Altme**. They are two different projects, two different repos.
- Constraint: do NOT modify altme-bot code/commits/deploys. For altme-bot issues → write a bug-report, never touch its code directly.

### Archived dead monolith
- The old gitea repo `llm-agents/llmems` (the Altme monolith, not the library) was **renamed → `altme-monolith-legacy` and archived** (read-only) on 2026-05-23. Old URL 301-redirects.
- It is DEAD: not the library, not the live bot. Do NOT restore it, deploy from it, or reference it as active.

These are settled facts as of 2026-05-23. The old monolith is archived & dead; Altme lives in its own `altme-bot` repo. Do NOT re-investigate this separation.
