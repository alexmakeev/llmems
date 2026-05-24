# llmems — Project Index

## Current State

`@alexmakeev/llmems` v0.3.3 — TypeScript long-term memory library for LLM agents.
Published to GitHub Packages (`@alexmakeev/llmems`), tag-driven CD via `.github/workflows/publish.yml`.

**2026-05-23:** fixed git/registry drift, cut v0.3.3 (first tag-driven CD publish), removed stale `gitea` remote, renamed + archived dead monolith → `altme-monolith-legacy`.

## Repository Topology

### llmems library (this repo)
- Remote: `origin` = `git@github.com:alexmakeev/llmems.git` (GitHub only — `gitea` remote removed).
- Publishes to GitHub Packages, package `@alexmakeev/llmems`.
- CD via tag push (`vX.Y.Z`). Never `npm publish` manually.
- Local layout: bare repo at `/home/alexmak/llmems/`, worktrees inside it.

### Altme bot ("Altbot") — separate project
- Separate repo: `gitea.oneln.ru` / org `llm-agents` / repo `altme-bot`.
- llmems is a library consumed by Altme. Two different repos, two different projects.
- Altme deploys from `altme-bot.git` via Dokploy — NOT from any local `~/llmems/` path.
- Do NOT modify altme-bot code/commits/deploys; write a bug-report for altme-bot issues.

### Archived dead monolith
- Old gitea repo `llm-agents/llmems` (the Altme monolith) renamed → `altme-monolith-legacy`, archived 2026-05-23.
- Dead: not the library, not the live bot. Do NOT restore or deploy from it.

## Active Beads

Open beads (as of 2026-05-23 — run `bd list` for current status):

| ID | P | Summary |
|----|---|---------|
| llmems-ccj | P2 | Port ask() fix to experiment branches (axis-projections, context-factory, graph-memory) |
| llmems-e08 | P2 | ContextFactory session Map — implement eviction/TTL/LRU |
| llmems-dnh | P2 | Restore frozen recall gold-set on this machine |
| llmems-xcz | P2 | Phase 2 — Structure and context-completion (dosborka) epic |
| llmems-wji | P2 | docs: benchmark pipeline runbook |
| llmems-2le | P2 | fix: re-extract-projections.ts missing OpenRouter config |
| llmems-a9r | P2 | security: remove hardcoded dev-DB password from benchmark scripts |
| llmems-3zq | P3 | Bump GitHub Actions to Node 24-compatible versions |
| llmems-t62 | P3 | altme-bot duplicated llmems chat logic — reconcile on next bump |

Sub-beads of llmems-xcz: xcz.1 (mem typing), xcz.2 (hierarchical mems), xcz.3 (graph context-completion), xcz.4 (Phase 2 uplift measurement).

## What's Next

1. Port ask() fix to all experiment branches (llmems-ccj, P2).
2. Restore recall gold-set (llmems-dnh), then run Phase 2 uplift measurement (llmems-xcz.4).
3. Security: remove hardcoded dev-DB password (llmems-a9r).
4. See `bd list -s priority` for current priority order.
