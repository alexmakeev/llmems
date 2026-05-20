// scripts/rebuild-graph.ts
// Rebuilds graph edges only (re-using existing projections) with configurable thresholds.
// Does NOT re-extract projections or re-embed — only changes which candidates pass the threshold.
//
// Usage:
//   SIMILARITY_THRESHOLD=0.5 npx tsx scripts/rebuild-graph.ts
//
// Env vars:
//   POSTGRES_URL            — DB connection (default: branch DB)
//   SIMILARITY_THRESHOLD    — cosine similarity cutoff (default: 0.7)
//   TOP_K_PER_AXIS          — candidates per axis per mem (default: 5)
//   MAX_EDGES               — max edges proposed by Gemini per mem (default: 20)
//   OPENROUTER_API_KEY      — required for Gemini edge proposals
//   DELAY_MS                — rate-limit delay between mems in ms (default: 500)

import { Pool } from 'pg';
import OpenAI from 'openai';
import pgvector from 'pgvector/pg';
import { z } from 'zod';

import { SEMANTIC_AXES } from '../src/services/graph/types.js';
import type { SemanticAxis, EdgeType, GraphEdge } from '../src/services/graph/types.js';
import { requireEnvInt } from '../src/shared/env.js';

// ── Config ─────────────────────────────────────────────────────────────────────

const POSTGRES_URL = process.env['POSTGRES_URL'] ??
  'postgresql://llmems:pEDqwhPpyd3KYiy1rg5O0d8nGwTZxUvJ@localhost:5434/llmems_axis_projections';

const OPENROUTER_API_KEY = process.env['OPENROUTER_API_KEY'] ?? '';
if (!OPENROUTER_API_KEY) {
  console.error('ERROR: OPENROUTER_API_KEY is required');
  process.exit(1);
}

const SIMILARITY_THRESHOLD = parseFloat(process.env['SIMILARITY_THRESHOLD'] ?? '0.7');
const TOP_K_PER_AXIS = parseInt(process.env['TOP_K_PER_AXIS'] ?? '5', 10);
const MAX_EDGES = parseInt(process.env['MAX_EDGES'] ?? '20', 10);
const DELAY_MS = parseInt(process.env['DELAY_MS'] ?? '500', 10);

const MEMSTORE_ID = requireEnvInt('MEMSTORE_ID');
const GEMINI_MODEL = 'google/gemini-2.5-flash';

// ── Zod schema for edge proposals ─────────────────────────────────────────────

const EdgeProposalSchema = z.object({
  source_id: z.string().max(50),
  target_id: z.string().max(50),
  edge_type: z.enum(['temporal', 'spatial', 'social', 'semantic', 'causal', 'emotional', 'epistemic']),
  label: z.string().max(200),
  relevance: z.number().min(0).max(1),
});

const EdgeProposalsArraySchema = z.array(EdgeProposalSchema);

// ── Axis display names (Russian) ───────────────────────────────────────────────

const AXIS_DISPLAY_NAMES: Record<SemanticAxis, string> = {
  chronos: 'Хронос (время)',
  topos: 'Топос (место)',
  agents: 'Агенты (люди)',
  theme: 'Тема (содержание)',
  cause: 'Причина (мотивы)',
  emotion: 'Эмоции (переживания)',
  certainty: 'Уверенность (достоверность)',
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractMemId(memIdStr: string): string | null {
  const match = /^mem-(\d+)$/.exec(memIdStr);
  if (match === null) return null;
  const id = match[1];
  return id !== undefined ? id : null;
}

function findArrayInObject(obj: Record<string, unknown>): unknown[] | null {
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) return value as unknown[];
  }
  return null;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Rebuild Graph Edges ===');
  console.log(`Memstore ID:          ${MEMSTORE_ID}`);
  console.log(`Similarity threshold: ${SIMILARITY_THRESHOLD}`);
  console.log(`Top-K per axis:       ${TOP_K_PER_AXIS}`);
  console.log(`Max edges (Gemini):   ${MAX_EDGES}`);
  console.log(`Delay between mems:   ${DELAY_MS}ms`);
  console.log('');

  const pool = new Pool({ connectionString: POSTGRES_URL });
  // Note: pgvector.registerType is NOT used — it conflicts with pg@8 connection lifecycle.
  // pgvector returns vector columns as strings "[x,y,z]" which we parse manually.
  // pgvector.toSql() is still used to format embeddings for query parameters.

  // Verify connection + print counts before
  const client = await pool.connect();
  const versionRow = await client.query<{ version: string }>('SELECT version()');
  console.log(`PostgreSQL: ${versionRow.rows[0]?.version?.split(' ').slice(0, 2).join(' ') ?? 'unknown'}`);

  const memsCountRow = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM mems WHERE memstore_id = $1`,
    [MEMSTORE_ID],
  );
  const projCountRow = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM mem_projections WHERE memstore_id = $1`,
    [MEMSTORE_ID],
  );
  const edgeCountBefore = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM mem_edges WHERE source_mem_id IN (SELECT id FROM mems WHERE memstore_id = $1)`,
    [MEMSTORE_ID],
  );
  console.log(`Mems:        ${memsCountRow.rows[0]?.count ?? 0}`);
  console.log(`Projections: ${projCountRow.rows[0]?.count ?? 0}`);
  console.log(`Edges (before): ${edgeCountBefore.rows[0]?.count ?? 0}`);
  console.log('');

  // Step 1: Delete all existing edges for this memstore
  console.log('Deleting existing edges...');
  const deleteResult = await client.query(
    `DELETE FROM mem_edges WHERE source_mem_id IN (SELECT id FROM mems WHERE memstore_id = $1)`,
    [MEMSTORE_ID],
  );
  console.log(`Deleted ${deleteResult.rowCount ?? 0} edges.`);
  console.log('');

  // Step 2: Load all mems for this memstore
  const memsResult = await client.query<{ id: number; summary: string }>(
    `SELECT id, summary FROM mems WHERE memstore_id = $1 ORDER BY id`,
    [MEMSTORE_ID],
  );
  const mems = memsResult.rows;
  console.log(`Loaded ${mems.length} mems to process.`);
  console.log('');

  // Step 3: Load all projections with embeddings for this memstore (one batch)
  const allProjectionsResult = await client.query<{
    mem_id: number;
    axis: string;
    text: string;
    embedding: string;
  }>(
    `SELECT mem_id, axis, text, embedding::text FROM mem_projections
     WHERE memstore_id = $1 AND embedding IS NOT NULL`,
    [MEMSTORE_ID],
  );
  console.log(`Loaded ${allProjectionsResult.rows.length} projections with embeddings.`);
  console.log('');
  client.release();

  // Build memTextsMap for Gemini prompts
  const memTextsMap = new Map<number, string>();
  for (const mem of mems) {
    memTextsMap.set(mem.id, mem.summary);
  }

  // Create Gemini client (via OpenRouter)
  const geminiClient = new OpenAI({
    apiKey: OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
  });

  let totalEdgesCreated = 0;
  let memsWithEdges = 0;
  let memsSkipped = 0;
  let memsError = 0;

  // Step 4: For each mem, find similar projections per axis, call Gemini, save edges
  for (let i = 0; i < mems.length; i++) {
    const mem = mems[i];
    if (mem === undefined) continue;

    const progress = `[${String(i + 1).padStart(3)}/${mems.length}]`;
    process.stdout.write(`${progress} mem-${mem.id}: `);

    // Get this mem's projections
    const memProjections = allProjectionsResult.rows.filter(p => p.mem_id === mem.id);

    if (memProjections.length === 0) {
      console.log('no projections, skipping');
      memsSkipped++;
      continue;
    }

    // Group candidates by axis
    const discoveryAxisMap = new Map<string, SemanticAxis>();
    const groupsByAxis = new Map<SemanticAxis, Array<{ memId: string; text: string; similarity: number }>>();

    for (const proj of memProjections) {
      const axis = proj.axis as SemanticAxis;
      if (!SEMANTIC_AXES.includes(axis)) continue;

      // Parse embedding from pgvector text format "[0.1,0.2,...]"
      let embeddingVec: number[];
      try {
        const embStr = proj.embedding.replace(/^\[/, '').replace(/\]$/, '');
        embeddingVec = embStr.split(',').map(Number);
      } catch {
        continue;
      }

      if (embeddingVec.length === 0) continue;

      // Find similar projections in DB for this axis
      const embeddingSql = pgvector.toSql(embeddingVec);
      let candidateRows: Array<{ mem_id: number; text: string; similarity: number }>;
      try {
        const result = await pool.query<{ mem_id: number; text: string; similarity: number }>(
          `SELECT mem_id, text, 1 - (embedding <=> $1) AS similarity
           FROM mem_projections
           WHERE memstore_id = $2
             AND axis = $3
             AND mem_id != $4
             AND 1 - (embedding <=> $1) >= $5
           ORDER BY similarity DESC
           LIMIT $6`,
          [embeddingSql, MEMSTORE_ID, axis, mem.id, SIMILARITY_THRESHOLD, TOP_K_PER_AXIS],
        );
        candidateRows = result.rows;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`\n  DB error for axis ${axis}: ${message}`);
        continue;
      }

      if (candidateRows.length === 0) continue;

      const existingGroup = groupsByAxis.get(axis) ?? [];
      for (const row of candidateRows) {
        const candidateMemIdStr = String(row.mem_id);
        existingGroup.push({
          memId: candidateMemIdStr,
          text: row.text,
          similarity: row.similarity,
        });
        if (!discoveryAxisMap.has(candidateMemIdStr)) {
          discoveryAxisMap.set(candidateMemIdStr, axis);
        }
      }
      groupsByAxis.set(axis, existingGroup);
    }

    const totalCandidates = Array.from(groupsByAxis.values()).reduce((sum, arr) => sum + arr.length, 0);

    if (totalCandidates === 0) {
      console.log('no candidates found');
      memsSkipped++;
      if (i + 1 < mems.length) await sleep(100);
      continue;
    }

    // Build Gemini prompt
    const memText = mem.summary;
    const lines: string[] = [
      'Ты анализируешь связи между воспоминаниями. Тебе дан текущий мем и кандидаты на связь, найденные по разным семантическим осям.',
      '',
      'Предложи 10-20 наиболее релевантных связей. Каждая связь должна быть важна для будущего припоминания — помогать находить это воспоминание в нужный момент.',
      '',
      'Типы связей:',
      '- temporal: временная связь (произошло до/после, одновременно)',
      '- spatial: пространственная (то же место, рядом)',
      '- social: социальная (те же люди, отношения)',
      '- semantic: тематическая (та же тема, похожий контекст)',
      '- causal: причинно-следственная (одно вызвало другое)',
      '- emotional: эмоциональная (похожие переживания)',
      '- epistemic: эпистемическая (подтверждает/опровергает, уточняет)',
      '',
      'Тип связи НЕ обязан совпадать с осью, по которой найден кандидат. Выбирай тип по смыслу самой связи.',
      '',
      `Текущий мем [mem-${mem.id}]:`,
      memText,
      '',
      'Кандидаты по осям:',
      '',
    ];

    for (const axis of SEMANTIC_AXES) {
      const group = groupsByAxis.get(axis);
      if (group === undefined || group.length === 0) continue;

      const displayName = AXIS_DISPLAY_NAMES[axis];
      lines.push(`=== ${displayName} ===`);

      for (const candidate of group) {
        const candidateIdNum = Number(candidate.memId);
        const candidateText = memTextsMap.get(candidateIdNum) ?? candidate.text;
        lines.push(`[mem-${candidate.memId}]: ${candidateText}`);
      }

      lines.push('');
    }

    lines.push(
      'Ответь строго JSON массивом:',
      '[',
      '  {',
      `    "source_id": "mem-${mem.id}",`,
      '    "target_id": "mem-{targetId}",',
      '    "edge_type": "temporal|spatial|social|semantic|causal|emotional|epistemic",',
      '    "label": "краткое_описание_связи",',
      '    "relevance": 0.0-1.0',
      '  }',
      ']',
    );

    const prompt = lines.join('\n');

    // Call Gemini
    let edgeProposals: z.infer<typeof EdgeProposalsArraySchema>;
    try {
      const response = await geminiClient.chat.completions.create({
        model: GEMINI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      });

      const choice = response.choices[0];
      if (choice === undefined || choice.message.content === null) {
        console.log('Gemini returned empty response, skipping');
        memsError++;
        if (i + 1 < mems.length) await sleep(DELAY_MS);
        continue;
      }

      const rawContent = choice.message.content;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawContent);
      } catch {
        console.log('Gemini JSON parse failed, skipping');
        memsError++;
        if (i + 1 < mems.length) await sleep(DELAY_MS);
        continue;
      }

      const arrayToValidate = Array.isArray(parsed)
        ? parsed
        : (parsed !== null && typeof parsed === 'object'
            ? findArrayInObject(parsed as Record<string, unknown>)
            : null);

      if (arrayToValidate === null) {
        console.log('Gemini response has no array, skipping');
        memsError++;
        if (i + 1 < mems.length) await sleep(DELAY_MS);
        continue;
      }

      const validation = EdgeProposalsArraySchema.safeParse(arrayToValidate);
      if (!validation.success) {
        console.log(`Gemini schema validation failed: ${validation.error.message.slice(0, 60)}, skipping`);
        memsError++;
        if (i + 1 < mems.length) await sleep(DELAY_MS);
        continue;
      }

      edgeProposals = validation.data;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.log(`Gemini API error: ${message.slice(0, 80)}, skipping`);
      memsError++;
      if (i + 1 < mems.length) await sleep(DELAY_MS);
      continue;
    }

    // Convert proposals to edges and save
    const edges: GraphEdge[] = [];
    for (const proposal of edgeProposals.slice(0, MAX_EDGES)) {
      const sourceMemIdStr = extractMemId(proposal.source_id);
      if (sourceMemIdStr === null) continue;

      const targetMemIdStr = extractMemId(proposal.target_id);
      if (targetMemIdStr === null) continue;

      const discoveryAxis: SemanticAxis = discoveryAxisMap.get(targetMemIdStr) ?? 'theme';
      edges.push({
        sourceMemId: String(mem.id),
        targetMemId: targetMemIdStr,
        edgeType: proposal.edge_type as EdgeType,
        label: proposal.label,
        relevance: proposal.relevance,
        discoveryAxis,
      });
    }

    if (edges.length > 0) {
      const dbClient = await pool.connect();
      try {
        await dbClient.query('BEGIN');
        for (const edge of edges) {
          const sourceMemIdNum = Number(edge.sourceMemId);
          const targetMemIdNum = Number(edge.targetMemId);
          await dbClient.query(
            `INSERT INTO mem_edges
               (memstore_id, source_mem_id, target_mem_id, edge_type, label, relevance, discovery_axis)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (source_mem_id, target_mem_id, edge_type)
             DO UPDATE SET label = EXCLUDED.label,
                           relevance = EXCLUDED.relevance,
                           discovery_axis = EXCLUDED.discovery_axis`,
            [MEMSTORE_ID, sourceMemIdNum, targetMemIdNum, edge.edgeType, edge.label, edge.relevance, edge.discoveryAxis],
          );
        }
        await dbClient.query('COMMIT');
      } catch (e) {
        await dbClient.query('ROLLBACK');
        const message = e instanceof Error ? e.message : String(e);
        console.error(`\n  saveEdges failed: ${message}`);
        memsError++;
        dbClient.release();
        if (i + 1 < mems.length) await sleep(DELAY_MS);
        continue;
      } finally {
        dbClient.release();
      }

      totalEdgesCreated += edges.length;
      memsWithEdges++;
      console.log(`candidates:${totalCandidates} edges:${edges.length}`);
    } else {
      console.log('no valid edges from Gemini');
      memsSkipped++;
    }

    if (i + 1 < mems.length) await sleep(DELAY_MS);
  }

  // Final count
  const finalCountRow = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM mem_edges WHERE source_mem_id IN (SELECT id FROM mems WHERE memstore_id = $1)`,
    [MEMSTORE_ID],
  );

  console.log('');
  console.log('=== Done ===');
  console.log(`Mems processed:     ${mems.length}`);
  console.log(`Mems with edges:    ${memsWithEdges}`);
  console.log(`Mems skipped:       ${memsSkipped}`);
  console.log(`Mems with errors:   ${memsError}`);
  console.log(`Edges created (sum of per-mem proposals): ${totalEdgesCreated}`);
  console.log(`Edges in DB (final, deduped): ${finalCountRow.rows[0]?.count ?? 0}`);

  await pool.end();
}

main().catch((e: unknown) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
