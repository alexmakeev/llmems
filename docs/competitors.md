# Competitors & Prior Art — LLM Agent Memory

> Last updated: 2026-06-08. Research basis: `materials/research-2026-06-08-llmems-alternatives.md` (4 research iterations).

## Why this doc

llmems goal is a lightweight embedded self-hosted TypeScript context-constructor with background debounce summarization and zero cloud backend. This document tracks who else solves this problem, what to learn from them, and which benchmarks to measure against. The framing is practical: adopt a competitor if one fits, build with eyes open if none does.

## What counts as a competitor: context-constructor vs memory-store

The key classification axis is **how the caller interacts with the memory system**:

- **Context-constructor (Type A — full wrapper):** wraps the LLM call itself. Caller sends a message, gets an assistant answer back; memory injection happens transparently inside the call. llmems `OpenRouterChat` is this type.
- **Context-constructor (Type B — context-block provider):** does not call the LLM; instead returns a ready prompt-block string the caller inserts into their own system prompt before calling the LLM.
- **Memory-store:** caller calls `search()` and assembles the final prompt themselves. Not a constructor.

llmems = **Type A**. This lens determines who competes directly.

### System classification (16 systems surveyed)

| System | Class | Wraps LLM? | Auto-inject? | Closeness to llmems |
|--------|-------|-----------|-------------|---------------------|
| Memori (MemoriLabs) | Constructor A | Yes (`llm.register()`) | Yes | HIGH |
| SuperMemory Infinite Chat | Hybrid (A-proxy + store) | Yes (proxy via `baseURL`) | Yes | HIGH |
| Mastra | Constructor A | Yes (`agent.generate()`) | Yes | HIGH (but heavy framework) |
| Letta (MemGPT) | Constructor A | Yes (`messages.create()`) | Yes | HIGH (but heavy runtime) |
| Honcho | Hybrid (B + chat) | Partial | Yes | MEDIUM-HIGH |
| Zep / Graphiti | Constructor B | No | Yes | MEDIUM |
| Memobase | Constructor B | No | Yes | MEDIUM |
| Cognee | Hybrid | Optional | Yes | MEDIUM |
| MemOS | Hybrid | Optional (`chat()`) | Yes | MEDIUM |
| LangChain RunnableWithMessageHistory | Constructor A (history only) | Yes | History yes; vector recall no | MEDIUM |
| Hindsight | Hybrid | `reflect()` calls LLM | Yes | MEDIUM |
| Mem0 | Memory-store | No | No | LOW |
| LangMem | Memory-store | No | No | LOW |
| A-MEM | Memory-store | No | No | LOW |
| Neo4j Agent Memory | Memory-store | No | No | LOW |
| Memary | Memory-store (inside their ChatAgent) | Only inside their agent | Only inside their agent | LOW-MEDIUM |

---

## The four finalists: build-vs-adopt deep-dive

These four systems are the closest context-constructors to llmems and were evaluated for "adopt vs build further."

### Memori (MemoriLabs)

**Maturity:** ~15 200 GitHub stars; Python + TypeScript + Rust; v3.3.6 (May 2026, company: MemoriLabs / GibsonAI). TypeScript SDK is young (launched March 2026). SaaS tier is production-ready; BYODB branch is newer and less battle-tested.

**Memory & context mechanism:** Semantic triples (subject–predicate–object). BYODB mode: fastembed / all-MiniLM locally, own Postgres. `llm.register(client)` wraps the caller's LLM client and transparently injects facts. Per-message extraction — no debounce (issue [#366](https://github.com/MemoriLabs/Memori/issues/366), unresponded as of research date).

**Self-hostability & lock-in:** Apache 2.0 SDK + your own Postgres for storage. However, the **Advanced Augmentation** feature (the recall and injection step) routes through their cloud: free tier is rate-limited by IP; production usage requires a `MEMORI_API_KEY`. The core value-add has real vendor lock-in.

**Limitations / where it's raw:**
- Per-message extraction is token-expensive at scale (issue #366, no roadmap response from maintainers).
- Augmentation behind cloud rate-limits — contradicts "zero external calls."
- BYODB mode is immature; attribution requirement in some tiers.

**What to adopt:** Zero-refactor integration ergonomics of `llm.register(client)` — a pattern worth copying. Semantic triples as a structured memory format. Local fastembed for embedding without a separate service.

**Verdict as llmems replacement:** Does not fit. The key feature (augmentation) requires their cloud. Contradicts the "zero external calls except the chosen LLM endpoint" invariant.

---

### SuperMemory

**Maturity:** ~26 100 stars (highest of all surveyed); TypeScript 64.6%; MIT on the open repos. Claims #1 on LongMemEval and LoCoMo (see Honesty Invariant in Benchmarks section); sub-300 ms retrieval.

**Memory & context mechanism:** Extracts static long-term facts + dynamic recent facts per conversation. Contradiction resolution ("moved to SF supersedes I live in NYC"). Automatic forgetting for time-bound facts ("exam tomorrow"). Hybrid semantic + keyword retrieval. Infinite Chat / Memory Router operates as a `baseURL` proxy — Type A wrapper.

**Self-hostability & lock-in:** This is the critical limitation. The memory extraction and retrieval core is **closed-source**. The open-source repos contain only the front-end, MCP connectors, and SDK wrappers. Official self-hosting is enterprise-tier on Cloudflare Workers. The proxy routes prompts through their servers. There is an unofficial community fork (`s11ngh/supermemory-selfhosted`) but it is not the official product.

**Limitations / where it's raw:**
- Core logic is proprietary — cannot self-host the valuable part.
- All prompt data passes through their infrastructure.
- Cloudflare-specific deployment for self-host enterprise option.

**What to adopt:** Contradiction resolution + auto-forget of time-bound facts is the strongest idea in this space and is absent from llmems. Memory Router proxy pattern as an alternative integration surface. Their [MemoryBench](https://github.com/supermemoryai/memorybench) harness is the recommended benchmark tool (see Benchmarks section).

**Verdict as llmems replacement:** Does not fit. Only ideas, not code.

---

### Mastra

**Maturity:** ~24 900 stars; TypeScript 99.3%; `@mastra/core` v1.41.0 (core 1.x is the stable track); daily releases; founded by ex-Gatsby team, YC W25. Dual-licensed: Apache 2.0 core + proprietary enterprise edition (`/ee/` directory).

**Memory & context mechanism:** Four-layer system: Conversation History + Working Memory + Semantic Recall (RAG) + Observational Memory (background auto-compression, introduced Feb 2026). Pluggable storage: PostgreSQL/pgvector (IVFFlat or HNSW), LibSQL, MongoDB. `agent.generate(msg, { memory: { threadId, resourceId } })` — Type A constructor. Also exposes a `TokenLimiter` processor and `MemoryProcessor` interface for filtering what reaches context. Note: this is a full **agent framework**, not a thin wrapper.

**Self-hostability & lock-in:** Fully self-hostable with own Postgres; Apache 2.0 core requires no cloud. Lock-in is soft: enterprise features in `/ee/`; adopting Mastra means migrating to their agent model.

**Limitations / where it's raw:**
- **Crash issue [#5214](https://github.com/mastra-ai/mastra/issues/5214):** primary-key violation on double insert during semantic recall + Vercel AI SDK combination — unresolved as of research date.
- Tool-call payloads can overflow context window if not filtered before injection.
- Heavy framework (not a thin layer); 187+ open issues; occasional breaking changes in minor releases.
- No debounce-based summarizer; observational memory trigger differs from llmems debounce.

**What to adopt:** Pluggable pgvector with explicit HNSW vs IVFFlat choice + `MemoryProcessor` / `TokenLimiter` pipeline. Observational compression of old messages into dense summaries. TypeScript-first thread/resource DX. Evals and observability tooling.

**Verdict as llmems replacement:** Fits with caveats — the only fully self-hosted + TypeScript + Apache + constructor option in the survey. But it is a framework, not a thin layer; memory subsystem is still maturing; adopting it means living inside Mastra.

---

### Letta (formerly MemGPT)

**Maturity:** ~23 200 stars; Python 99.5% core; v0.16.8 (0.x — API not frozen); 177 releases; venture-backed (letta-ai). TypeScript is client-SDK only; core is a Python server.

**Memory & context mechanism:** OS-inspired hierarchy: Core Memory (always in-window, editable "blocks") → Recall Memory (recent turns, vector searchable) → Archival Memory (unlimited long-term, vector). LLM itself manages memory movement via function calls (`memory_append`, `memory_replace`, etc.). `client.agents.messages.create()` — Type A. No debounce.

**Self-hostability & lock-in:** Apache 2.0, but running it means deploying a **full Python server**: Docker, ~42 DB tables at startup, mandatory Postgres at `LETTA_PG_URI`. TypeScript consumers call it via HTTP client SDK. Not embedded in-process.

**Limitations / where it's raw:**
- Runtime overhead: >1.5 GB memory under load; OOM kills reported; ~50–200 MB/month DB growth per agent.
- Requires explicit embedding configuration; 504 timeouts on long calls.
- 0.x means API instability; for a TypeScript project, this is a foreign Python server alongside your process.

**What to adopt:** Tiered memory architecture with explicit window visibility (inspectable, editable Core Memory blocks). LLM-driven memory self-management as a future mode. Concept of directly inspectable and editable memory blocks for debugging.

**Verdict as llmems replacement:** Does not fit. Python server, not embedded TypeScript.

---

### Comparison table

| Criterion | Memori | SuperMemory | Mastra | Letta |
|-----------|--------|-------------|--------|-------|
| Stars (approx.) | 15 200 | 26 100 | 24 900 | 23 200 |
| Primary language | Python + TS + Rust | TS wrappers + closed core | TS 99.3% | Python core, TS client |
| Fully self-hostable? | Partial (augment in cloud) | No (enterprise + Cloudflare) | Yes | Yes, but heavy server |
| License | Apache SDK / cloud augment | MIT wrappers, core closed | Apache core / EE proprietary | Apache 2.0 |
| Async / debounce | Per-message, no debounce | Background (closed) | Processors, no debounce | Agent-driven, no debounce |
| Key limitation | Augment in cloud; per-message cost | Core closed; self-host enterprise only | Heavy framework; crash #5214 | Python server; not embedded |
| llmems replacement? | No (cloud dependency) | No | With caveats | No |

---

## Verdict: build vs adopt

No finalist fully fits the requirement of "lightweight embedded self-hosted TypeScript wrapper, zero cloud backend, no agent-framework dependency." The gap is real and the niche is real:

- **Mastra** is the closest (self-hosted + TS + Apache + constructor), but it is a heavy agent framework with a still-maturing memory subsystem. Adopting it means migrating all agent code to Mastra's model.
- **SuperMemory** leads on benchmark scores but its core is closed-source SaaS.
- **Memori** has the right DX pattern but its key feature (augmentation) requires their cloud.
- **Letta** has the most sophisticated memory model but is a Python server.

Building llmems further is justified. The differentiator to protect:

1. **Everything in-process** — zero external calls except the chosen LLM endpoint.
2. **Token-thrifty debounce** — background summarization triggered by idle time, not per-message extraction.
3. **Thin wrapper, not a framework** — caller keeps their existing code; `OpenRouterChat` is a drop-in.

---

## Implementation lessons — what to adopt and HOW

The highest-priority ideas to incorporate, with concrete mapping to llmems:

**Contradiction resolution + auto-forget of time-bound facts (SuperMemory)**
SuperMemory detects when a new fact supersedes an old one ("moved to SF" → mark "I live in NYC" as superseded) and automatically expires time-scoped facts ("exam tomorrow" → expire after 24h). llmems has no conflict detection today. How to apply: during `insert_mem`, run a semantic search for close existing mems, then use a small LLM call to classify as ADD / UPDATE / NOOP / DELETE (the same algorithm Mem0 uses, documented in their paper arxiv.org/abs/2504.19413). Add an `expires_at` column to `mem` table for explicit time-bound facts; debounce summarizer should detect expiry markers in text.

**`llm.register(client)` transparent-wrapper DX (Memori)**
Memori's key UX insight: the caller does not refactor any existing code. They call `llm.register(myOpenAIClient)` once and every subsequent call to `client.chat.completions.create()` automatically injects memory. How to apply in llmems: `OpenRouterChat` already is the wrapper, but exposing a `register(existingClient)` factory function that returns a memory-augmented proxy of an existing `openai`-compatible client would allow zero-refactor adoption.

**Pluggable pgvector index: HNSW vs IVFFlat + `MemoryProcessor` / `TokenLimiter` (Mastra)**
Mastra exposes the index type as a config option and applies `MemoryProcessor` steps (including `TokenLimiter`) to filter and truncate retrieved memories before injection. How to apply: llmems should expose `indexType: 'hnsw' | 'ivfflat'` in storage config (HNSW is better for large collections; IVFFlat is faster to build but degrades at scale). Implement a `MemoryProcessor` chain: at minimum, a token-budget filter that truncates injected context to a configurable token ceiling before it reaches the prompt.

**Observational compression of old messages into dense summaries (Mastra)**
Mastra's observational memory compresses older conversation turns into dense summaries in the background. This differs from llmems debounce: Mastra triggers on turn count or recency, llmems triggers on idle time. How to apply: consider a complementary trigger — after N turns (configurable, e.g. 20), force a summarization pass regardless of idle time. This catches high-frequency conversations where idle time never fires.

**Tiered / inspectable memory blocks (Letta)**
Letta makes Core Memory (always-in-window contents) directly readable and editable via API. Developers can inspect exactly what is in the context window and edit memory blocks for debugging or correction. How to apply: expose a `mem.list({ inWindow: true })` query that returns which mems are currently injected into the context, and a `mem.update(id, content)` for manual correction. This transforms llmems from a black box into an inspectable system.

**Idempotent insertion / dedup (lesson from Mastra crash #5214)**
Mastra's crash #5214 is a primary-key violation on double insert during concurrent semantic recall + insert. How to apply: llmems `insert_mem` should be idempotent — use `INSERT ... ON CONFLICT DO NOTHING` keyed on a content hash, and hold a per-session advisory lock during the debounce flush to prevent concurrent inserts of the same summarization output.

**Filtering tool-call payloads before injection (Mastra)**
Tool-call results (especially large JSON payloads from function calls) can flood the context window when naively injected as memory. Mastra's `MemoryProcessor` filters these out. How to apply: in the debounce summarizer, skip or truncate messages where `role === 'tool'` and `content.length > threshold`; summarize the tool's semantic outcome instead of injecting the raw payload.

---

## Limitations of competitors to design around

Top five failure modes observed in the surveyed systems, with direct implications for llmems design:

1. **Per-message token waste (Memori [#366](https://github.com/MemoriLabs/Memori/issues/366)):** extracting facts on every message is expensive. llmems debounce approach is objectively more token-efficient; this advantage should be measured (see Benchmarks — ConvoMem).
2. **Dedup / idempotency on insert (Mastra [#5214](https://github.com/mastra-ai/mastra/issues/5214)):** concurrent inserts during recall cause crashes. Use content-hash dedup + advisory locks.
3. **Tool-call payload overflow (Mastra):** raw tool results injected into memory context overflow the window. Filter role=`tool` payloads before injection.
4. **pgvector growth + index degradation (Letta OOM; Mastra IVFFlat vs HNSW):** naive IVFFlat degrades as collection grows; Letta reports OOM kills and ~50–200 MB/month growth per agent. Plan HNSW from the start and implement periodic pruning of low-relevance mems.
5. **Hidden cloud backend on the key feature (Memori augmentation, SuperMemory proxy):** both present as "self-hostable" but the valuable feature routes through their cloud. The "zero external calls except LLM endpoint" invariant must be an explicit, tested contract in llmems — not a side effect.

---

## Benchmarks to measure llmems against

### Recommended benchmark set (priority order)

| # | Benchmark | What it measures | Key metrics | Source | Applicability | Integration effort |
|---|-----------|-----------------|------------|--------|--------------|-------------------|
| 1 | **MemoryBench** | Harness over 3 datasets; unified MemScore | MemScore (accuracy + latency + avg context tokens) | [github.com/supermemoryai/memorybench](https://github.com/supermemoryai/memorybench) | MAXIMAL — TypeScript/Bun, provider-agnostic | LOW-MEDIUM |
| 2 | **LoCoMo** (inside MemoryBench) | Long-conversation memory: factual / temporal / multi-hop / adversarial | F1, ROUGE, LLM-judge, Recall@k | [github.com/mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks) | HIGH — all key competitors report on it; direct comparability | LOW-MEDIUM |
| 3 | **ConvoMem** (Salesforce, inside MemoryBench) | 6 evidence categories: user facts, assistant facts, abstention, preferences, changing facts, implicit connections | Accuracy + token-cost + latency | [HF: Salesforce/ConvoMem](https://huggingface.co/datasets/Salesforce/ConvoMem), [code](https://github.com/SalesforceAIResearch/ConvoMem), [paper](https://arxiv.org/html/2511.10523v1) | HIGH — thesis directly validates llmems niche (see below) | MEDIUM |
| 4 | **LongMemEval-S** (cleaned) | 5 abilities: information extraction, multi-session reasoning, temporal reasoning, knowledge updates, abstention | Accuracy (GPT-4o judge, >97% human agreement), Recall@k, NDCG@k | [github.com/xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval), [HF dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned), [paper](https://arxiv.org/html/2410.10813v1) | HIGH — ICLR 2025 industry standard; knowledge-updates + abstention probe llmems weak spots | MEDIUM |

### Why ConvoMem is strategically important

ConvoMem's central thesis directly validates the llmems design niche:

- **Below ~150 dialogs:** naive full-context scores 70–82% accuracy. Pure RAG memory (Mem0-style) only 30–45% — RAG hurts at short context.
- **After 150–300 dialogs:** RAG pays off — 95× token savings, with an accuracy drop.
- **Block-based extraction (≈ llmems debounce approach):** holds 70–75% accuracy with 30× latency speedup via parallelization.

This gives an objective frame for positioning: llmems debounce beats pure RAG in the sub-150-dialog regime AND is more token-efficient than full-context. ConvoMem lets us measure this precisely.

LongMemEval needle-in-haystack: accuracy drops 30–60% vs oracle retrieval across ~40–50 distractor sessions (~115K tokens, 500 questions). Knowledge-updates and abstention tasks directly probe where llmems mems may contain stale or conflicting facts.

### Minimal harness to build

A TypeScript adapter for llmems against the MemoryBench interface, with two phases:

**Ingest phase (`ingest(sessions)`):** feed sessions through `OpenRouterChat` so the debounce summarization produces mems.

> **Critical:** provide a test hook to force-flush the debounce synchronously before the query phase — `await session.flushDebounce()` or equivalent. Without this, mems are not yet written at question time and accuracy is falsely deflated. This is the same problem Zep documented ("ingestion takes a few minutes after upload"); solve it explicitly in the test harness.

**Query phase (`answer(question)` / `getContext(question)`):** use a `dryRun` mode to return the assembled context string (for retrieval metrics: Recall@k, NDCG@k) and/or submit to the LLM for a direct answer (for judge accuracy metrics).

**LLM-judge wrapper:** wrap GPT-4o (or a Flash-class model — ConvoMem showed Flash is equivalent to GPT-4o for judging at ~8× lower cost).

**Incremental validation:** first run on 10–20 questions (~$0.005–0.05), confirm the pipeline is green, then scale to 500+ questions.

### Honesty invariant — mandatory

Follow the LoCoMo protocol strictly:
- Use categories 1–4 only (factual/temporal/multi-hop/adversarial).
- Run 10 iterations; report mean ± variance.
- Use identical prompts for llmems and the baseline.
- Do **not** tune the judge prompt to favor llmems.

**Cautionary case (Zep / LoCoMo):** Zep reported 84% on LoCoMo; correct recompute was 58.44% ([zep-papers #5](https://github.com/getzep/zep-papers/issues/5)). The inflated number came from: including category 5 (adversarial) in the numerator while excluding it from the denominator; modified prompts; single run instead of 10. Do not repeat this.

### Watch-list (2026 — not for first benchmark pass)

| Benchmark | What it adds | Status | Effort |
|-----------|-------------|--------|--------|
| **MemoryAgentBench** | Conflict Resolution, Associative Retrieval, Test-Time Learning, Long-Range tasks | ICLR 2026; [github.com/HUST-AI-HYZ/MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench) | HIGH (Python) |
| **BEAM** | Memory over up to 10M tokens; 2000 probes | ICLR 2026 paper | HIGH (stress test) |
| **AMA-Bench** | Memory over agent tool-call trajectories | [arxiv.org/abs/2602.22769](https://arxiv.org/abs/2602.22769) | HIGH (Python) |

---

## Sources

### Competitors

- [github.com/mem0ai/mem0](https://github.com/mem0ai/mem0) — Mem0
- [arxiv.org/abs/2504.19413](https://arxiv.org/abs/2504.19413) — Mem0 paper
- [github.com/getzep/graphiti](https://github.com/getzep/graphiti) — Graphiti / Zep
- [arxiv.org/abs/2501.13956](https://arxiv.org/abs/2501.13956) — Zep paper
- [arxiv.org/abs/2502.12110](https://arxiv.org/abs/2502.12110) — A-MEM paper (NeurIPS 2025)
- [github.com/langchain-ai/langmem](https://github.com/langchain-ai/langmem) — LangMem
- [github.com/plastic-labs/honcho](https://github.com/plastic-labs/honcho) — Honcho
- [github.com/memodb-io/memobase](https://github.com/memodb-io/memobase) — Memobase
- [github.com/supermemoryai/supermemory](https://github.com/supermemoryai/supermemory) — SuperMemory
- [github.com/MemoriLabs/Memori](https://github.com/MemoriLabs/Memori) — Memori
- [github.com/MemoriLabs/Memori/issues/366](https://github.com/MemoriLabs/Memori/issues/366) — Memori per-message token cost issue
- [memorilabs.ai/docs/memori-byodb/concepts/how-memory-works/](https://memorilabs.ai/docs/memori-byodb/concepts/how-memory-works/)
- [supermemory.ai/docs/deployment/self-hosting](https://supermemory.ai/docs/deployment/self-hosting)
- [supermemory.ai/docs/model-enhancement/context-extender](https://supermemory.ai/docs/model-enhancement/context-extender)
- [github.com/s11ngh/supermemory-selfhosted](https://github.com/s11ngh/supermemory-selfhosted) — unofficial community fork
- [github.com/mastra-ai/mastra](https://github.com/mastra-ai/mastra) — Mastra
- [github.com/mastra-ai/mastra/issues/5214](https://github.com/mastra-ai/mastra/issues/5214) — Mastra dedup crash
- [mastra.ai/docs/memory/semantic-recall](https://mastra.ai/docs/memory/semantic-recall)
- [github.com/letta-ai/letta](https://github.com/letta-ai/letta) — Letta
- [docs.letta.com/guides/docker/postgres/](https://docs.letta.com/guides/docker/postgres/)
- [docs.letta.com/guides/selfhosting/performance/](https://docs.letta.com/guides/selfhosting/performance/)
- [github.com/MemTensor/MemOS](https://github.com/MemTensor/MemOS) — MemOS
- [arxiv.org/abs/2512.12818](https://arxiv.org/abs/2512.12818) — Hindsight paper
- [vectorize.io/articles/best-ai-agent-memory-systems](https://vectorize.io/articles/best-ai-agent-memory-systems)
- [mem0.ai/blog/state-of-ai-agent-memory-2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [github.com/TeleAI-UAGI/Awesome-Agent-Memory](https://github.com/TeleAI-UAGI/Awesome-Agent-Memory)

### Benchmarks

- [github.com/supermemoryai/memorybench](https://github.com/supermemoryai/memorybench) — MemoryBench harness (TS/Bun)
- [github.com/mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks) — LoCoMo runners
- [huggingface.co/datasets/Salesforce/ConvoMem](https://huggingface.co/datasets/Salesforce/ConvoMem) — ConvoMem dataset
- [github.com/SalesforceAIResearch/ConvoMem](https://github.com/SalesforceAIResearch/ConvoMem) — ConvoMem code
- [arxiv.org/html/2511.10523v1](https://arxiv.org/html/2511.10523v1) — ConvoMem paper
- [github.com/xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval) — LongMemEval-S repo
- [huggingface.co/datasets/xiaowu0162/longmemeval-cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) — LongMemEval-S dataset
- [arxiv.org/html/2410.10813v1](https://arxiv.org/html/2410.10813v1) — LongMemEval paper (ICLR 2025)
- [github.com/getzep/zep-papers/issues/5](https://github.com/getzep/zep-papers/issues/5) — Zep LoCoMo benchmark recompute (honesty cautionary case)
- [github.com/HUST-AI-HYZ/MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench) — MemoryAgentBench (watch-list)
- [arxiv.org/abs/2602.22769](https://arxiv.org/abs/2602.22769) — AMA-Bench paper (watch-list)
