# llmems Prototype Harness (Phase 1B)

Standalone consumer of the **published** `@alexmakeev/llmems` package, exercising
cross-session memory against the AM32 test stand (beads llmems-3io.8/.9). It is a CLI,
not a service: no Dokploy, no deploy artifact. Plan: `materials/plan-phase1b.md` v2 (D9–D16).

The harness deliberately prototypes the **consumer pattern**: time-boxed critical path
(`Promise.race` vs `LLMEMS_CRITICAL_TIMEOUT_MS`), degrade-to-empty on timeout/error,
hard context cap (`LLMEMS_MAX_CONTEXT_CHARS`, prefix-keep), and the `llmems.*`
structured-log taxonomy (`error`, `context_injected`, `timeout_degraded`, `late_settle`,
`context_truncated`) — the contract any future consumer carries forward.

## Layout

- `src/embedding-adapter.ts` — `IEmbeddingService` over LiteLLM `/v1/embeddings`, 1536-dim, Result-typed errors
- `src/turn-pipeline.ts` — the time-boxed/capped/logged turn wrapper
- `src/run-scope.ts` — run-scoped `contextId` (= `sessionId`) + unique Russian nonce (stale-mems immunity)
- `src/fixture.ts` — Russian planted-fact dialogue (≥ default `indexThreshold`), recall probe, nonce assert
- `src/seed.ts` / `src/recall.ts` — the two phases; seed exits only after mems rows exist (bounded poll, loud failure)
- `src/cli.ts` — thin wiring of real collaborators (`PostgresMemStore`, `BackgroundIndexer`, `LLMSummarizer`)
- `tests/` — offline unit tests (mocks only: no network, no DB, no paid calls)

## Running tests (offline, no stand required)

```bash
cd harness
npm install      # pulls @alexmakeev/llmems from GitHub Packages (needs ~/.npmrc auth)
npm test
```

## Running the smoke on the AM32 stand (bead .9 — paid calls under the $5 scoped key)

Config lives in `~/llmems-stand/.env` (created by bead .7). Required keys:
`POSTGRES_URL`, `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `LLMEMS_SUMMARIZER_MODEL`,
`LLMEMS_EMBEDDINGS_MODEL`. Optional: `LLMEMS_CRITICAL_TIMEOUT_MS` (1500),
`LLMEMS_MAX_CONTEXT_CHARS` (12000), `LLMEMS_MARKER_TEXT` (Russian default),
`LLMEMS_INDEX_THRESHOLD`, `LLMEMS_SEED_POLL_TIMEOUT_MS` (120000),
`LLMEMS_SEED_POLL_INTERVAL_MS` (2000), `LLMEMS_RUN_STATE_FILE` (default: `<env dir>/last-run.json`).

```bash
cd harness && npm install
npm run seed     # process 1: fixture → indexing wait → state file
npm run recall   # process 2 (fresh): probe → planted-fact assert (exit 1 on fail)
```

Seed and recall share one run scope via the state file; every smoke run generates a
fresh `contextId` and a fresh Russian nonce, so leftovers from prior runs in the
long-lived stand DB can never satisfy the assert.

## Boundaries

- Zero changes to library code (`src/` of the repo) — the harness consumes the published artifact only.
- Not part of the npm package (root `files: ["dist"]`) and not part of the root test suite
  (root vitest includes only `src/**`; CI does not install harness deps).
- Prod is never touched; all spend goes through the scoped `llmems-teststand` key ($5 hard cap).
