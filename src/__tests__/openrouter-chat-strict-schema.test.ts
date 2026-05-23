// src/__tests__/openrouter-chat-strict-schema.test.ts
// RED → GREEN unit test for the strict-mode JSON-schema transform's
// nullable-optional promotion (E1).
//
// OpenAI/OpenRouter strict mode requires EVERY property to be listed in
// `required`. The transform achieves that by promoting all properties into
// `required`. But a property that was OPTIONAL in the Zod schema may legitimately
// be absent at runtime — forcing it into `required` while keeping a single
// non-null type would make the schema unsatisfiable for the "absent" case.
//
// Fix: when promoting a previously-optional property into `required`, widen its
// type to also allow null (so "absent" maps to "null"). Already-nullable and
// already-required-non-null properties stay untouched.
//
// We exercise the transform through the public surface: a configured
// responseFormat is converted into the wire `response_format.json_schema.schema`
// by the request assembler, captured here via a fetch spy.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { OpenRouterChat } from '../openrouter-chat.ts';
import { ok } from '../shared/result.ts';
import type { LLMem, RecallMemoryResult } from '../openrouter-chat.ts';

vi.mock('../retry-sleep.ts', () => ({
  retrySleep: vi.fn().mockResolvedValue(undefined),
}));
import { InMemoryMemStore } from '../services/mem-manager.ts';

function createMockLLMem(): LLMem {
  return {
    contextId: 'test-context',
    store: vi.fn().mockResolvedValue(ok({ stored: true })),
    recall: vi.fn().mockResolvedValue(
      ok({ recall: { nodes: [], edges: [] } } as RecallMemoryResult),
    ),
  } as unknown as LLMem;
}

function mockTextResponse(content: string): Response {
  return {
    ok: true,
    json: () =>
      Promise.resolve({ choices: [{ message: { content, tool_calls: undefined } }] }),
    text: () => Promise.resolve(content),
  } as unknown as Response;
}

interface JsonSchemaObject {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: unknown;
}
interface JsonSchemaNode {
  type?: string | string[];
  anyOf?: Array<{ type?: string | string[] }>;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: unknown;
}

/** True if the node permits a null value (single type incl. "null", or an anyOf null branch). */
function allowsNull(node: JsonSchemaNode): boolean {
  if (node.type !== undefined) {
    return Array.isArray(node.type) ? node.type.includes('null') : node.type === 'null';
  }
  if (Array.isArray(node.anyOf)) {
    return node.anyOf.some((b) =>
      Array.isArray(b.type) ? b.type.includes('null') : b.type === 'null',
    );
  }
  return false;
}

/** True if the node is a single non-null type (e.g. {type:"string"}). */
function isSingleNonNullType(node: JsonSchemaNode): boolean {
  return typeof node.type === 'string' && node.type !== 'null';
}

async function captureWireSchema(schema: z.ZodSchema): Promise<JsonSchemaObject> {
  const fetchSpy = vi.fn().mockResolvedValue(mockTextResponse('{}'));
  vi.stubGlobal('fetch', fetchSpy);

  const chat = new OpenRouterChat({
    apiKey: 'sk-test',
    systemPrompt: 'test',
    llmem: createMockLLMem(),
    memStore: new InMemoryMemStore(),
    backgroundDebounceMs: 999999,
    responseFormat: { schema },
  });
  await chat.ask('q');

  const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as {
    response_format?: { json_schema?: { schema?: JsonSchemaObject } };
  };
  const wire = body.response_format?.json_schema?.schema;
  if (!wire) throw new Error('no wire schema captured');
  return wire;
}

describe('strict JSON-schema nullable-optional promotion (E1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('promotes optional props to required AND widens their type to include null; required-non-null and already-nullable untouched', async () => {
    const schema = z.object({
      reqStr: z.string(),                       // required, non-null → stays single non-null
      optStr: z.string().optional(),            // optional only → becomes nullable + required
      nullStr: z.string().nullable(),           // already nullable, already required → untouched
      optNullStr: z.string().optional().nullable(), // optional + nullable → already has null branch, just required
    });

    const wire = await captureWireSchema(schema);

    // Every property must be in `required` (strict mode).
    expect(wire.required).toEqual(
      expect.arrayContaining(['reqStr', 'optStr', 'nullStr', 'optNullStr']),
    );
    expect(wire.required).toHaveLength(4);

    // additionalProperties:false on the object.
    expect(wire.additionalProperties).toBe(false);

    const props = wire.properties!;

    // Previously-optional, non-null → now allows null.
    expect(allowsNull(props.optStr!)).toBe(true);

    // Already-required non-null field keeps a single non-null type.
    expect(isSingleNonNullType(props.reqStr!)).toBe(true);
    expect(allowsNull(props.reqStr!)).toBe(false);

    // Already-nullable required field stays nullable (untouched).
    expect(allowsNull(props.nullStr!)).toBe(true);

    // Optional+nullable already had a null branch — still nullable.
    expect(allowsNull(props.optNullStr!)).toBe(true);
  });

  it('applies the same rule recursively to nested objects, with additionalProperties:false on every object', async () => {
    const schema = z.object({
      outer: z.object({
        innerReq: z.string(),
        innerOpt: z.number().optional(),
      }),
    });

    const wire = await captureWireSchema(schema);

    expect(wire.additionalProperties).toBe(false);
    const outer = wire.properties!.outer!;
    expect(outer.additionalProperties).toBe(false);
    expect(outer.required).toEqual(expect.arrayContaining(['innerReq', 'innerOpt']));
    expect(outer.required).toHaveLength(2);

    const innerProps = outer.properties!;
    // Optional nested numeric field widened to allow null.
    expect(allowsNull(innerProps.innerOpt!)).toBe(true);
    // Required nested field stays single non-null.
    expect(isSingleNonNullType(innerProps.innerReq!)).toBe(true);
    expect(allowsNull(innerProps.innerReq!)).toBe(false);
  });
});
