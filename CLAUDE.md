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
