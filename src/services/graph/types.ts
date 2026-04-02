// src/services/graph/types.ts
// Types for the projection-based knowledge graph system.

// 7 semantic axes
export type SemanticAxis = 'chronos' | 'topos' | 'agents' | 'theme' | 'cause' | 'emotion' | 'certainty';

export const SEMANTIC_AXES: readonly SemanticAxis[] = [
  'chronos',
  'topos',
  'agents',
  'theme',
  'cause',
  'emotion',
  'certainty',
] as const;

// Edge types the graph supports
export type EdgeType = 'temporal' | 'spatial' | 'social' | 'semantic' | 'causal' | 'emotional' | 'epistemic';

// Projection extracted from a mem
export interface MemProjection {
  memId: string;        // references mems.id
  axis: SemanticAxis;
  text: string;         // extracted projection text
  embedding?: number[]; // 1536d OpenAI embedding (filled after embedding step)
}

// Edge proposed by Gemini
export interface GraphEdge {
  id?: string;
  sourceMemId: string;
  targetMemId: string;
  edgeType: EdgeType;
  label: string;        // human-readable label like "happened_before", "same_person"
  relevance: number;    // 0.0-1.0 from Gemini
  discoveryAxis: SemanticAxis; // which axis found this candidate
  createdAt?: Date;
}

// Candidate found by per-axis similarity search
export interface AxisCandidate {
  memId: string;
  axis: SemanticAxis;
  similarity: number;
  projectionText: string; // the projection text of the candidate
}

// Grouped candidates for Gemini prompt
export interface GroupedCandidates {
  sourceMem: { id: string; text: string };
  groups: Map<SemanticAxis, Array<{ memId: string; text: string; similarity: number }>>;
}

// Gemini's response for edge proposals
export interface GeminiEdgeProposal {
  source_id: string;
  target_id: string;
  edge_type: EdgeType;
  label: string;
  relevance: number;
}

// Config for the graph system
export interface GraphConfig {
  similarityThreshold: number;  // default 0.7
  topKPerAxis: number;          // default 5
  maxEdgesFromGemini: number;   // default 20
  openaiApiKey: string;
  openaiBaseUrl?: string;       // default undefined → api.openai.com; set to OpenRouter URL when using OR key
  openaiModel: string;          // default 'text-embedding-3-small'
  geminiApiKey?: string;        // uses openrouter if not set
  geminiModel: string;          // default 'google/gemini-2.5-flash'
}
