// src/services/graph/graph-store.ts
// PostgreSQL storage layer for mem projections and knowledge graph edges.

import type { Pool } from 'pg';
import pgvector from 'pgvector/pg';
import { ok, err } from '../../shared/result.js';
import type { Result } from '../../shared/result.js';
import { createMemoryLogger } from '../../logging.js';
import type { MemoryLogger } from '../../logging.js';
import type {
  MemProjection,
  SemanticAxis,
  AxisCandidate,
  GraphEdge,
  EdgeType,
} from './types.js';

// ──────────────────────────────────────────────────────────────────────────────
// GraphStore
// ──────────────────────────────────────────────────────────────────────────────

export class GraphStore {
  private readonly pool: Pool;
  private readonly logger: MemoryLogger;

  constructor(pool: Pool) {
    this.pool = pool;
    this.logger = createMemoryLogger({ name: 'graph-store' });
  }

  /**
   * Resolve contextId → memstores.id
   */
  async getMemstoreId(contextId: string): Promise<Result<number, Error>> {
    try {
      const result = await this.pool.query<{ id: number }>(
        `SELECT id FROM memstores WHERE name = $1`,
        [contextId],
      );

      const row = result.rows[0];
      if (row === undefined) {
        return err(new Error(`GraphStore: memstore not found for contextId="${contextId}"`));
      }

      return ok(row.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ err: message, contextId }, 'GraphStore.getMemstoreId failed');
      return err(new Error(`getMemstoreId failed: ${message}`));
    }
  }

  /**
   * Save projections (with embeddings) to DB.
   * Uses INSERT ... ON CONFLICT (mem_id, axis) DO UPDATE for idempotency.
   */
  async saveProjections(
    projections: MemProjection[],
    memstoreId: number,
  ): Promise<Result<void, Error>> {
    if (projections.length === 0) return ok(undefined);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const proj of projections) {
        const memIdNum = Number(proj.memId);
        const embeddingSql = proj.embedding !== undefined && proj.embedding.length > 0
          ? pgvector.toSql(proj.embedding)
          : null;

        await client.query(
          `INSERT INTO mem_projections (mem_id, memstore_id, axis, text, embedding)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (mem_id, axis)
           DO UPDATE SET text = EXCLUDED.text, embedding = EXCLUDED.embedding`,
          [memIdNum, memstoreId, proj.axis, proj.text, embeddingSql],
        );
      }

      await client.query('COMMIT');
      this.logger.debug(
        { count: projections.length, memstoreId },
        'GraphStore.saveProjections: saved',
      );
      return ok(undefined);
    } catch (e) {
      await client.query('ROLLBACK');
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ err: message, memstoreId }, 'GraphStore.saveProjections failed');
      return err(new Error(`saveProjections failed: ${message}`));
    } finally {
      client.release();
    }
  }

  /**
   * Find similar projections per axis using pgvector cosine distance.
   * Returns top-K projections with similarity >= threshold, excluding the source mem.
   */
  async findSimilarByAxis(
    embedding: number[],
    axis: SemanticAxis,
    memstoreId: number,
    excludeMemId: number,
    threshold: number,
    topK: number,
  ): Promise<Result<AxisCandidate[], Error>> {
    try {
      const embeddingSql = pgvector.toSql(embedding);

      const result = await this.pool.query<{
        mem_id: number;
        text: string;
        similarity: number;
      }>(
        `SELECT mem_id, text, 1 - (embedding <=> $1) AS similarity
         FROM mem_projections
         WHERE memstore_id = $2
           AND axis = $3
           AND mem_id != $4
           AND 1 - (embedding <=> $1) >= $5
         ORDER BY similarity DESC
         LIMIT $6`,
        [embeddingSql, memstoreId, axis, excludeMemId, threshold, topK],
      );

      const candidates: AxisCandidate[] = result.rows.map(row => ({
        memId: String(row.mem_id),
        axis,
        similarity: row.similarity,
        projectionText: row.text,
      }));

      return ok(candidates);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ err: message, axis, memstoreId }, 'GraphStore.findSimilarByAxis failed');
      return err(new Error(`findSimilarByAxis failed: ${message}`));
    }
  }

  /**
   * Save edges to DB.
   * Uses INSERT ... ON CONFLICT (source_mem_id, target_mem_id, edge_type) DO UPDATE for idempotency.
   */
  async saveEdges(edges: GraphEdge[], memstoreId: number): Promise<Result<void, Error>> {
    if (edges.length === 0) return ok(undefined);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const edge of edges) {
        const sourceMemId = Number(edge.sourceMemId);
        const targetMemId = Number(edge.targetMemId);

        await client.query(
          `INSERT INTO mem_edges
             (memstore_id, source_mem_id, target_mem_id, edge_type, label, relevance, discovery_axis)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (source_mem_id, target_mem_id, edge_type)
           DO UPDATE SET label = EXCLUDED.label,
                         relevance = EXCLUDED.relevance,
                         discovery_axis = EXCLUDED.discovery_axis`,
          [memstoreId, sourceMemId, targetMemId, edge.edgeType, edge.label, edge.relevance, edge.discoveryAxis],
        );
      }

      await client.query('COMMIT');
      this.logger.debug(
        { count: edges.length, memstoreId },
        'GraphStore.saveEdges: saved',
      );
      return ok(undefined);
    } catch (e) {
      await client.query('ROLLBACK');
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ err: message, memstoreId }, 'GraphStore.saveEdges failed');
      return err(new Error(`saveEdges failed: ${message}`));
    } finally {
      client.release();
    }
  }

  /**
   * Get edges for a set of mem IDs (source OR target in provided set).
   */
  async getEdgesForMems(memIds: number[], memstoreId: number): Promise<Result<GraphEdge[], Error>> {
    if (memIds.length === 0) return ok([]);

    try {
      const result = await this.pool.query<{
        id: number;
        source_mem_id: number;
        target_mem_id: number;
        edge_type: string;
        label: string;
        relevance: number;
        discovery_axis: string;
        created_at: Date;
      }>(
        `SELECT id, source_mem_id, target_mem_id, edge_type, label, relevance, discovery_axis, created_at
         FROM mem_edges
         WHERE memstore_id = $1
           AND (source_mem_id = ANY($2::int[]) OR target_mem_id = ANY($2::int[]))`,
        [memstoreId, memIds],
      );

      const edges: GraphEdge[] = result.rows.map(row => ({
        id: String(row.id),
        sourceMemId: String(row.source_mem_id),
        targetMemId: String(row.target_mem_id),
        edgeType: row.edge_type as EdgeType,
        label: row.label,
        relevance: row.relevance,
        discoveryAxis: row.discovery_axis as SemanticAxis,
        createdAt: row.created_at,
      }));

      return ok(edges);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ err: message, memstoreId }, 'GraphStore.getEdgesForMems failed');
      return err(new Error(`getEdgesForMems failed: ${message}`));
    }
  }

  /**
   * Get original mem text by ID (from mems table, field is "summary").
   */
  async getMemText(memId: number): Promise<Result<string, Error>> {
    try {
      const result = await this.pool.query<{ summary: string }>(
        `SELECT summary FROM mems WHERE id = $1`,
        [memId],
      );

      const row = result.rows[0];
      if (row === undefined) {
        return err(new Error(`GraphStore: mem not found for id=${memId}`));
      }

      return ok(row.summary);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ err: message, memId }, 'GraphStore.getMemText failed');
      return err(new Error(`getMemText failed: ${message}`));
    }
  }

  /**
   * Get mem texts for multiple IDs (batch).
   * Returns a Map from memId → summary text.
   */
  async getMemTexts(memIds: number[]): Promise<Result<Map<number, string>, Error>> {
    if (memIds.length === 0) return ok(new Map());

    try {
      const result = await this.pool.query<{ id: number; summary: string }>(
        `SELECT id, summary FROM mems WHERE id = ANY($1::int[])`,
        [memIds],
      );

      const map = new Map<number, string>();
      for (const row of result.rows) {
        map.set(row.id, row.summary);
      }

      return ok(map);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error({ err: message }, 'GraphStore.getMemTexts failed');
      return err(new Error(`getMemTexts failed: ${message}`));
    }
  }
}

