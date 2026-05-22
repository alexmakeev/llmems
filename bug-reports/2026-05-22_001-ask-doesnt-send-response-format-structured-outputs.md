---
id: 001
title: "ask() doesn't send response_format (structured outputs) and drops max_tokens"
severity: high
priority: P1
status: open
created: 2026-05-22
updated: 2026-05-22
component: core
tags: [core, openrouter, structured-outputs, max-tokens, api, ask]
environment:
  claude_version: "claude-opus-4-7"
  os: "Linux 5.15.0-176-generic"
  setup_repo_version: "886e1d1"
related_bugs: []
fix_commit: ""
---

# Bug Report: ask() doesn't send response_format (structured outputs) and drops max_tokens

## Summary

Through the public `ask()` API, a consumer cannot get OpenRouter structured output (strict JSON, no markdown fences) nor set an output-token cap. Models such as `google/gemini-2.5-flash-lite` therefore wrap JSON in ` ```json ` fences AND truncate long outputs at OpenRouter's small default completion budget. Discovered by a downstream consumer (mysterra world-generator): a real L1 generation run produced 0/81 cells — all 3 model responses were markdown-fenced and truncated mid-JSON.

---

## Severity/Priority Rationale

**Severity:** high
- Major feature broken: consumers cannot get reliable structured JSON from models that support it
- No clean workaround — manual `JSON.parse` + fence-stripping is fragile; `max_tokens` cap is simply unavailable through `ask()`

**Priority:** P1
- Blocks a downstream consumer's core feature (mysterra world generation is blocked at 0 cells)
- Model support for `response_format` and `max_tokens` is confirmed on OpenRouter; the issue is entirely library-side

**Why this severity/priority:** `ask()` is the primary public API path. The inability to pass `response_format` and `max_tokens` silently degrades every consumer that relies on structured JSON generation with large outputs.

---

## Steps to Reproduce

1. Create an `OpenRouterChat` instance with `responseFormat: { schema: <ZodSchema> }` and a model that supports structured outputs (e.g. `google/gemini-2.5-flash-lite`)
2. Call `chat.ask(prompt)` with a prompt that expects a large structured JSON response (e.g. 81 rich objects ≈ 17K output tokens)
3. Observe:
   - The raw model response is wrapped in ` ```json … ``` ` markdown fences — `JSON.parse(rawText)` throws
   - The response is truncated mid-object (output hits OpenRouter's ~4K default completion budget, not the model's 65K ceiling)

**Reproducibility:** Always — when `ask()` is used with any model on OpenRouter that would otherwise produce markdown-fenced JSON without explicit `response_format`, and when output exceeds ~4K tokens without an explicit `max_tokens`.

---

## Expected Behavior

`chat.ask(prompt)` should send the configured `responseFormat.schema` as a strict `json_schema` `response_format` in the OpenRouter request body, and `maxTokens` (when provided) as `max_tokens`. The model should return raw JSON (no fences), and the output should not be cut at a small default cap.

```json
// Expected outgoing request body
{
  "model": "google/gemini-2.5-flash-lite",
  "messages": [...],
  "max_tokens": 32768,
  "provider": { "require_parameters": true },
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "children_batch",
      "strict": true,
      "schema": { "type": "object", "properties": {...}, "required": [...], "additionalProperties": false }
    }
  }
}
```

---

## Actual Behavior

`ask()` calls `callOpenRouter(askSystemContent, messages, undefined, 0)` — both `responseFormat` and `max_tokens` are always `undefined` on this path. The request body reaching OpenRouter is:

```json
{
  "model": "google/gemini-2.5-flash-lite",
  "messages": [...]
}
```

No `response_format`, no `max_tokens`, no `provider` field. OpenRouter applies its default completion budget (~4K tokens incl. reasoning), and the model wraps its answer in Markdown code fences. Result: `JSON.parse` throws → `parse_error: "model output is not valid JSON"`.

Observed in 3 consecutive real runs (llmems `ask()` call log):
- Response 0: ~54K chars, cut mid-token after 63/81 objects
- Response 1: ~49K chars, cut mid-token after 60/81 objects
- Response 2: ~9K chars, cut mid-token after 11/81 objects (variable — consumed by reasoning tokens)

---

## Root Cause Hypothesis

**Status:** confirmed

**Theory:**

`ask()` (openrouter-chat.ts ~line 325) hardwires `responseFormat = undefined` and never reads from `this.responseFormat`:

```typescript
// ask() call site — responseFormat is always undefined here
callOpenRouter(askSystemContent, messages, undefined, 0)
```

`callOpenRouter` (~lines 945-961) only sets `response_format` when its arg is truthy (it never is via `ask()`), and never sets `max_tokens` on this path at all. `max_tokens: 32768` appears only in `callOpenRouterWithTools` (~line 819), a separate code path that `ask()` never uses.

The constructor's `responseFormat.schema` (Zod) is stored in `this.responseFormat` but is only used to append `systemInstructions` text to the system prompt (`prompt()` path, ~lines 261-264). It is never converted to a wire-level `json_schema` request body. So the entire structured-output contract exists only as a prompt instruction nudge — not as an API-level constraint.

**Evidence:**
- `grep` of compiled `dist/openrouter-chat.js` confirms zero `max_tokens` in the `ask()` / `callOpenRouter` path
- Constructor `responseFormat.schema` field: stored at line 144, never referenced in `callOpenRouter` request body construction
- Real OpenRouter call log (3 records): `usage: null` (provider didn't return usage), responses confirmed markdown-fenced + truncated
- OpenRouter models API (`GET /api/v1/models`) confirms `google/gemini-2.5-flash-lite` lists `response_format`, `structured_outputs`, and `max_tokens` in `supported_parameters` — so the model supports all of this; the library simply doesn't send it

**Alternative theories:**
1. ~~Model doesn't support structured outputs~~ — disproved by OpenRouter API response
2. ~~OpenRouter routing problem~~ — disproved by model's `supported_parameters` list including all required fields

---

## Environment

| Item | Value |
|------|-------|
| llmems version | 0.3.0 (commit `886e1d1`) |
| OS | Linux 5.15.0-176-generic |
| Setup Repo Version | 526152f |
| Affected model | google/gemini-2.5-flash-lite (OpenRouter) |
| Consumer project | mysterra (src/llm/provider.ts) |

**Additional context:**
- OpenRouter supports both `json_object` (any JSON) and `json_schema` strict modes; strict is needed
- `provider: { require_parameters: true }` should accompany `response_format` to prevent silent fallback to unsupported providers
- Zod 4.4.3 (used by llmems) ships `z.toJSONSchema()` built-in — no new dependency needed for schema conversion

---

## Related Files

**Source files involved:**
- `src/openrouter-chat.ts` — `ask()` ~line 310–330, `callOpenRouter` ~lines 945–961, `callOpenRouterWithTools` max_tokens hardcoded ~line 819, `prompt()` responseFormat ~lines 261–264
- `dist/openrouter-chat.js` — compiled output

**Consumer workaround (to be removed after fix):**
- `/home/alexmak/mysterra/main/src/llm/provider.ts` — comment at lines 23–37 documents the workaround; `complete()` manually does `JSON.parse` + Zod `safeParse` precisely because `ask()` doesn't enforce structured output

---

## Logs and Traces

### Real run call log (survives in temp dir)

```
/tmp/mysterra-real-l1-K1WRXR/llm-calls.jsonl  (3 records)

Record 0: ~54123 chars output, truncated mid-token after 63 child objects
Record 1: ~48635 chars output, truncated mid-token after 60 child objects (unterminated string)
Record 2: ~9077 chars output, truncated mid-token after 11 child objects (consumed by reasoning)

All 3: usage: null, finish_reason: not captured (library discards response envelope)
All 3: response starts with "```json\n{" — markdown fence present
```

---

## Reproduction Method

### Manual Reproduction

1. In any project using llmems, create a chat with responseFormat + Zod schema
2. Call `ask()` with a prompt expecting large structured JSON
3. Inspect the raw `rawText` in `complete()` — it will start with ` ```json `
4. Or set a high `max_tokens` requirement and observe truncation at ~4K tokens

### E2E Test

**Status:** not-created

**Test file:** `tests/unit/openrouter-chat.test.ts` (extend existing suite)

**Test outline:**

```typescript
describe('ask() — structured outputs + max_tokens', () => {
  it('should send response_format json_schema when schema provided (RED: currently fails)', async () => {
    const capturedBody: unknown[] = []
    const stubAsk = async (body: unknown) => { capturedBody.push(body); return '{"result": 1}' }
    const chat = new OpenRouterChat({ ..., responseFormat: { schema: z.object({ result: z.number() }) } })
    await chat.ask('prompt', { maxTokens: 8192 })
    expect(capturedBody[0]).toMatchObject({
      response_format: { type: 'json_schema', json_schema: { strict: true } },
      max_tokens: 8192,
      provider: { require_parameters: true },
    })
  })

  it('ask() with no options should NOT add response_format or max_tokens (backward compat)', async () => {
    const capturedBody: unknown[] = []
    // ... stub setup ...
    await chat.ask('prompt')
    expect(capturedBody[0]).not.toHaveProperty('response_format')
    expect(capturedBody[0]).not.toHaveProperty('max_tokens')
  })
})
```

---

## Impact Assessment

**User Impact:**
- Who is affected: all consumers using `ask()` to get structured JSON from models via OpenRouter
- Frequency: every time a consumer relies on model-enforced JSON structure or needs large output (>4K tokens)
- Severity for user: blocking — generation produces 0 valid results

**System Impact:**
- Data loss risk: no
- Workaround available: partial — manual `JSON.parse` + fence-stripping is possible for small outputs; `max_tokens` cap is completely unavailable through the public API
- Affects other features: yes — any consumer that builds on `ask()` for structured generation

**Business Impact:**
- Blocks releases: yes (mysterra world generation)
- Affects production: potential — any consumer relying on large structured outputs
- User complaints: 1 confirmed (mysterra: 0/81 cells on real run)

---

## Workaround

**Status:** partial

**Temporary solution (consumer-side):**

```typescript
// Strip fences manually after ask()
const raw = await chat.ask(prompt)
const stripped = raw.replace(/^```json\s*/, '').replace(/\s*```$/, '')
const parsed = JSON.parse(stripped)
```

**Description:**

Fence-stripping handles Bug A (markdown wrapping) for short-enough outputs. `max_tokens` (Bug B) has **no workaround** through the public `ask()` API — the consumer simply cannot set it. The workaround is brittle (fails if model changes fence format) and unavailable for long outputs.

---

## Expected Fix

**Approach:**

1. Add an options bag to `ask()`: `ask(question: string, options?: { responseFormat?: z.ZodSchema | JsonSchema; maxTokens?: number }): Promise<string>`
2. Forward `options.responseFormat` and `options.maxTokens` to `callOpenRouter`
3. Extend `callOpenRouter` request body construction to set:
   - `max_tokens: options.maxTokens` when provided
   - `response_format: { type: "json_schema", json_schema: { name, strict: true, schema: toJSONSchema(schema) } }` when schema provided
   - `provider: { require_parameters: true }` when `response_format` is set
4. Use `z.toJSONSchema(schema)` (Zod 4 built-in) for Zod→JSON Schema conversion; verify output has `additionalProperties: false` and `required` arrays on all object levels (OpenRouter strict mode requirement)
5. Keep `ask(question)` with no options fully backward-compatible — no change to request body

**Code sketch:**

```typescript
// openrouter-chat.ts
async ask(question: string, options?: { responseFormat?: z.ZodSchema | object; maxTokens?: number }): Promise<string> {
  // ... existing setup ...
  return callOpenRouter(askSystemContent, messages, options?.responseFormat, 0, options?.maxTokens)
}

function callOpenRouter(system, messages, responseFormat?, temperature = 0, maxTokens?: number) {
  const body: Record<string, unknown> = { model: this.model, messages }
  if (temperature) body.temperature = temperature
  if (maxTokens) body.max_tokens = maxTokens
  if (responseFormat) {
    const schema = responseFormat instanceof z.ZodType
      ? z.toJSONSchema(responseFormat, { target: 'openai' })  // additionalProperties:false, required arrays
      : responseFormat
    body.response_format = { type: 'json_schema', json_schema: { name: 'response', strict: true, schema } }
    body.provider = { require_parameters: true }
  }
  // ... rest of call ...
}
```

**Tests to add:**
- Unit: `ask()` with `{ responseFormat, maxTokens }` → assert request body contains both (stub HTTP)
- Unit: `ask()` without options → assert request body unchanged (backward compat)
- Unit: Zod schema conversion → assert `additionalProperties: false` and `required` arrays present

**Consumer update (mysterra) after fix:**
- `src/llm/provider.ts` `complete()`: call `chat.ask(prompt, { responseFormat: req.schema, maxTokens: req.maxTokens })`
- Remove the workaround comment block (lines 23–37)
- `src/world/generator.ts`: pass `maxTokens` to `LlmRequest` (e.g. 32768 for L1 generation)

---

## TDD Coverage Plan

### Unit Tests
- **Existing test file:** `tests/unit/openrouter-chat.test.ts` (or equivalent in llmems test suite)
- **New asserts added:** request body contains `response_format` + `max_tokens` when provided; is unchanged without options
- **Status:** not-started

### Integration Tests
- **File:** `tests/integration/structured-output.test.ts` (new or extend)
- **New asserts added:** end-to-end ask() with stub → parses as valid structured JSON
- **Status:** not-started

### TDD Status
- [ ] RED phase: tests reproduce the bug (request body missing response_format/max_tokens)
- [ ] Bug localized: root cause identified ✅ (confirmed)
- [ ] Plan Mode: fix designed and approved
- [ ] GREEN phase: fix implemented, all tests pass

---

## Fix Status

**Status:** not-started

---

## Related Bugs

None known.

---

## Investigation Notes

**Timeline:**
- 2026-05-22: Bug discovered via real OpenRouter run in mysterra (L1 generation: 0/81 cells, 3 parse_error results)
- 2026-05-22: Root cause confirmed via code analysis + temp run log (all 3 responses markdown-fenced + truncated)
- 2026-05-22: Verified model supports structured_outputs + max_tokens via OpenRouter models API
- 2026-05-22: Bug report filed

**Reported by:** mysterra agent (session 2026-05-22)
**Investigated by:** mysterra agent (session 2026-05-22)

**Additional notes:**

The mysterra consumer (`src/llm/provider.ts`) already has a workaround comment (lines 23–37) that explicitly documents: *"ask() internally ignores the constructor's responseFormat and asks for plain text, so the JSON-schema hint is NOT sent on the wire."* This confirms the bug was partially known but not fixed at the library level.

OpenRouter references:
- Structured Outputs guide: https://openrouter.ai/docs/guides/features/structured-outputs
- Models API with supported_parameters: https://openrouter.ai/api/v1/models
- `require_parameters` usage: https://python.useinstructor.com/integrations/openrouter/

---

## Metadata

**Created:** 2026-05-22
**Last Updated:** 2026-05-22
**Assignee:** llmems maintainer
**Labels:** `bug`, `core`, `high-priority`, `openrouter`, `structured-outputs`, `max-tokens`
