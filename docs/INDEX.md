# llmems — Project Index / State Recap

Последнее обновление: 2026-06-09

## Current State

**Phase 1A — COMPLETE.** `@alexmakeev/llmems` v0.4.0 published to GitHub Packages. Tag `v0.4.0`, head
commit `79900cf` on `main`. 242 tests green. Workflow `publish.yml` run verified successful.

**What's next: Phase 1B** — test-stand integration of llmems into One Liner `prompt.ts`. See
[Active Beads](#active-beads) and `docs/product/next.md` for cold-restart pointer.

**2026-06-09 — v0.4.0 (Phase 1A):** merged `feature/context-factory` → `main`. This is the
**pivot to pure context generation**: `OpenRouterChat` (the LLM-calling chat wrapper) is **removed**; the library
no longer calls any LLM for chat. Public API is now `remember()` (mutates per-session state) and
`getCurrentContext()` (pure projection to a prompt-block string), plus two new APIs:
- `getCurrentContextParts()` — structured 3-part view (stable backbone / dynamic mems / raw tail), exposes boundary for cache-hint injection.
- `getLongTermContext()` — long-term-only mode, excludes active raw tail.

Generation/system-prompt/persona move OUT to the consumer. Hard breaking change under 0.x semver, matches
documented v0.4.0 intent.

**2026-05-23:** fixed git/registry drift, cut v0.3.3 (first tag-driven CD publish), removed stale `gitea`
remote, renamed + archived dead monolith → `altme-monolith-legacy`.

## v0.4.0 core (from feature/context-factory)

- **ContextFactory** (`src/services/context-factory.ts`) — `remember()` (rawTail append + per-turn focus vector +
  dedup mem-load + softRebuild + fire-and-forget indexing) and `getCurrentContext()` (pure projection:
  stable backbone block → "Loaded from memory:" marker → dynamic mems → raw tail). Cache-friendly stable prefix.
- **BackgroundIndexer** (`src/services/background-indexer.ts`) — raw chunks → closed mems, count-based trigger.
- **LLMSummarizer** (`src/services/llm-summarizer.ts`) — standalone OpenAI-compatible summarizer.
- **context-metric** (`src/services/context-metric.ts`) — `computeContextQualityScore`.

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
- Note: altme-bot currently vendors a COPY of the old chat logic (bead llmems-t62) — it does NOT consume the
  package today, so the v0.4.0 API break does not break altme-bot. Reconciliation tracked separately.

### Archived dead monolith
- Old gitea repo `llm-agents/llmems` (the Altme monolith) renamed → `altme-monolith-legacy`, archived 2026-05-23.
- Dead: not the library, not the live bot. Do NOT restore or deploy from it.

## Branches after consolidation

- `main` — v0.4.0 release line (this branch).
- `feature/context-factory` — merged into main (kept for history).
- `fix/ask-response-format` (was d8b0d4a) — DELETED (was an ancestor of main, 0 ahead; the ask() fix already
  shipped in v0.3.3, and the code it patched — `openrouter-chat.ts` — is deleted in v0.4.0, so nothing to port).
- `experiment/axis-projections` (b08f870, 23 commits ahead of main) — **PARKED, do NOT delete.** Holds the
  graph/axis-projection module (not on the release line). The graph bet is paused; keep as reference, re-evaluate
  in Phase 3 on real benchmark data.
- `experiment/graph-memory` (2fcab69, 1 commit ahead) — **PARKED, do NOT delete.** Superseded by feature's
  `vision.md`; behind axis-projections. Likely drop later, but kept for now.

## Active Beads

Run `bd list` for current status. Live epic:

- **llmems-3io** — Phase 1 epic (v0.4.0 in main + test-stand integration + long-memory benchmark).
  - `.1`–`.6` — **DONE** (Phase 1A: context-factory, getCurrentContextParts, getLongTermContext, merge, publish)
  - `.7` — Phase 1B: provision test-stand One Liner instance + PostgresMemStore schema (NEXT)
  - `.8` — Phase 1B: implement llmems middleware in One Liner `prompt.ts`
  - `.9` — Phase 1B: deploy to test-stand + smoke test (end of Phase 1B)
  - `.10` — Phase 1C: long-memory benchmark on test-stand (blocked by `.9` + backlog beads below)
  - `.11` — Phase 1D: report + decision (benchmark results → open-core boundary decision)

Blocking backlog (must resolve before `.10`): llmems-dnh (gold-set for recall), llmems-a9r (dev-DB
password in benchmark scripts), llmems-wji (benchmark runbook).

Carried-over (see `bd list -s priority`): llmems-e08 (session TTL/LRU/eviction), llmems-xcz (Phase 2
structure + graph, gated on baseline), llmems-3zq (Node 24 actions), llmems-t62 (altme-bot
vendored-copy reconcile).

Graph/axis branches (`experiment/axis-projections`, `experiment/graph-memory`) — **PARKED**. Do not
delete. Re-evaluate in Phase 3 on real benchmark data.

## Key files

| Файл | Роль |
|------|------|
| `src/services/context-factory.ts` | Основная реализация ContextFactory |
| `src/services/background-indexer.ts` | Standalone BackgroundIndexer (raw→mem→archive) |
| `src/services/llm-summarizer.ts` | Standalone LLMSummarizer (OpenAI-compatible) |
| `src/services/postgres-mem-store.ts` | PostgreSQL-реализация IVectorMemStore |
| `src/services/context-metric.ts` | Метрика качества контекста |
| `src/types.ts` | Доменные типы (Mem, EmbeddingValue, IVectorMemStore, …) |
| `src/index.ts` | Публичный barrel-экспорт библиотеки |
| `docs/vision.md` | Архитектурное видение (north-star) |
| `docs/building-a-chat.md` | Паттерн потребителя: чат поверх llmems |
| `docs/baseline-metric.md` | Методика и результат замера baseline |

## Further Reading

- [Competitors & Prior Art](competitors.md) — landscape of LLM-agent memory solutions, build-vs-adopt analysis.
- [Конкуренты и аналоги (RU)](competitors.ru.md) — русский перевод обзора.
- [Vision](vision.md) — архитектурное видение.
