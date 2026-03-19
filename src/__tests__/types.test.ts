// src/memory/__tests__/types.test.ts
// Tests for KnowledgeNode schema validation and new temporal types

import { describe, it, expect } from 'vitest';
import {
  knowledgeNodeSchema,
  entityTypes,
  edgeRelationTypes,
  getSalience,
  propositionExtractionResultSchema,
  sessionAnalysisResultSchema,
  type TemporalResolution,
  type DateRange,
  type KnowledgeNode,
} from '../types.ts';
import type { KnowledgeNode as ArangoKnowledgeNode, KnowledgeNodeInsert } from '../arango/types.ts';
import { getEffectiveDate } from '../utils/temporal.ts';

// ── KnowledgeNode temporal fields ────────────────────────────────────────────

describe('knowledgeNodeSchema — temporal fields', () => {
  const baseNode = {
    id: 'node-1',
    projectId: 'proj-1',
    text: 'Meeting with client',
    tags: [],
    source: 'task_completed',
    timestamp: 1700000000000,
  };

  it('validates a KnowledgeNode with all temporal fields set', () => {
    const result = knowledgeNodeSchema.safeParse({
      ...baseNode,
      tValid: '2024-01-15T10:00:00.000Z',
      tInvalid: '2024-03-01T00:00:00.000Z',
      tInvalidated: '2024-02-20T12:00:00.000Z',
      temporalSource: 'next Tuesday',
      resolvedBy: 'chrono',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tValid).toBe('2024-01-15T10:00:00.000Z');
      expect(result.data.tInvalid).toBe('2024-03-01T00:00:00.000Z');
      expect(result.data.tInvalidated).toBe('2024-02-20T12:00:00.000Z');
      expect(result.data.temporalSource).toBe('next Tuesday');
      expect(result.data.resolvedBy).toBe('chrono');
    }
  });

  it('validates resolvedBy enum values: llm', () => {
    const result = knowledgeNodeSchema.safeParse({
      ...baseNode,
      resolvedBy: 'llm',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resolvedBy).toBe('llm');
    }
  });

  it('validates resolvedBy enum values: session_anchor', () => {
    const result = knowledgeNodeSchema.safeParse({
      ...baseNode,
      resolvedBy: 'session_anchor',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resolvedBy).toBe('session_anchor');
    }
  });

  it('rejects an invalid resolvedBy value', () => {
    const result = knowledgeNodeSchema.safeParse({
      ...baseNode,
      resolvedBy: 'unknown_source',
    });
    expect(result.success).toBe(false);
  });

  it('validates KnowledgeNode without any temporal fields (backward compat)', () => {
    const result = knowledgeNodeSchema.safeParse(baseNode);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tValid).toBeUndefined();
      expect(result.data.tInvalid).toBeUndefined();
      expect(result.data.tInvalidated).toBeUndefined();
      expect(result.data.temporalSource).toBeUndefined();
      expect(result.data.resolvedBy).toBeUndefined();
    }
  });

  it('validates KnowledgeNode with only some temporal fields (partial)', () => {
    const result = knowledgeNodeSchema.safeParse({
      ...baseNode,
      tValid: '2024-06-01T00:00:00.000Z',
      resolvedBy: 'chrono',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tValid).toBe('2024-06-01T00:00:00.000Z');
      expect(result.data.resolvedBy).toBe('chrono');
      expect(result.data.tInvalid).toBeUndefined();
    }
  });
});

// ── entityTypes includes annual_event ────────────────────────────────────────

describe('entityTypes', () => {
  it('includes annual_event', () => {
    expect(entityTypes).toContain('annual_event');
  });

  it('validates KnowledgeNode with entityType annual_event', () => {
    const result = knowledgeNodeSchema.safeParse({
      id: 'evt-1',
      projectId: 'proj-1',
      text: 'Birthday party',
      tags: ['birthday'],
      source: 'user:stated',
      timestamp: 1700000000000,
      entityType: 'annual_event',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entityType).toBe('annual_event');
    }
  });

  it('still validates all pre-existing entity types', () => {
    const preExisting = ['person', 'place', 'concept', 'event', 'object', 'fact', 'session', 'topic_segment'] as const;
    for (const entityType of preExisting) {
      const result = knowledgeNodeSchema.safeParse({
        id: `node-${entityType}`,
        projectId: 'proj-1',
        text: `A ${entityType}`,
        tags: [],
        source: 'task_completed',
        timestamp: 1700000000000,
        entityType,
      });
      expect(result.success, `entityType '${entityType}' should be valid`).toBe(true);
    }
  });

  it('includes proposition as a valid entity type', () => {
    expect(entityTypes).toContain('proposition');
  });

  it('includes entity as a valid entity type', () => {
    expect(entityTypes).toContain('entity');
  });

  it('validates KnowledgeNode with entityType proposition', () => {
    const result = knowledgeNodeSchema.safeParse({
      id: 'prop-1',
      projectId: 'proj-1',
      text: 'User prefers dark mode for all applications',
      tags: ['preference'],
      source: 'session_consolidation',
      timestamp: 1700000000000,
      entityType: 'proposition',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entityType).toBe('proposition');
    }
  });

  it('validates KnowledgeNode with entityType entity', () => {
    const result = knowledgeNodeSchema.safeParse({
      id: 'ent-1',
      projectId: 'proj-1',
      text: 'TypeScript',
      tags: ['technology'],
      source: 'session_consolidation',
      timestamp: 1700000000000,
      entityType: 'entity',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entityType).toBe('entity');
    }
  });
});

// ── edgeRelationTypes includes 'mentions' ────────────────────────────────────

describe('edgeRelationTypes', () => {
  it('includes mentions as a valid edge relation type', () => {
    expect(edgeRelationTypes).toContain('mentions');
  });

  it('still includes all pre-existing edge relation types', () => {
    const preExisting = [
      'temporal_before', 'temporal_after', 'caused_by',
      'same_topic', 'elaborates', 'contradicts', 'contains', 'occurred_during',
    ] as const;
    for (const edgeType of preExisting) {
      expect(edgeRelationTypes, `edgeRelationType '${edgeType}' should be present`).toContain(edgeType);
    }
  });

  it('includes sequence as a valid edge relation type', () => {
    expect(edgeRelationTypes).toContain('sequence');
  });
});

// ── TemporalResolution interface ──────────────────────────────────────────────

describe('TemporalResolution', () => {
  it('accepts a valid TemporalResolution with date', () => {
    const resolution: TemporalResolution = {
      date: new Date('2024-03-15'),
      confidence: 0.9,
      source: 'chrono',
      original: 'March 15th',
    };
    expect(resolution.date).toBeInstanceOf(Date);
    expect(resolution.confidence).toBe(0.9);
    expect(resolution.source).toBe('chrono');
    expect(resolution.original).toBe('March 15th');
  });

  it('accepts a TemporalResolution with null date (unresolvable)', () => {
    const resolution: TemporalResolution = {
      date: null,
      confidence: 0,
      source: 'llm',
      original: 'sometime last year',
    };
    expect(resolution.date).toBeNull();
    expect(resolution.confidence).toBe(0);
  });

  it('accepts source values: llm, session_anchor', () => {
    const llm: TemporalResolution = {
      date: new Date(),
      confidence: 0.7,
      source: 'llm',
      original: 'last week',
    };
    const anchor: TemporalResolution = {
      date: new Date(),
      confidence: 1.0,
      source: 'session_anchor',
      original: 'today',
    };
    expect(llm.source).toBe('llm');
    expect(anchor.source).toBe('session_anchor');
  });
});

// ── DateRange interface ───────────────────────────────────────────────────────

describe('DateRange', () => {
  it('accepts a valid DateRange', () => {
    const range: DateRange = {
      from: new Date('2024-01-01'),
      to: new Date('2024-01-31'),
    };
    expect(range.from).toBeInstanceOf(Date);
    expect(range.to).toBeInstanceOf(Date);
    expect(range.from < range.to).toBe(true);
  });
});

// ── tMentioned field on KnowledgeNode ────────────────────────────────────────

describe('knowledgeNodeSchema — tMentioned field', () => {
  const baseNode = {
    id: 'node-1',
    projectId: 'proj-1',
    text: 'Some fact',
    tags: [],
    source: 'task_completed',
    timestamp: 1700000000000,
  };

  it('validates KnowledgeNode with tMentioned set', () => {
    const result = knowledgeNodeSchema.safeParse({
      ...baseNode,
      tMentioned: '2025-09-03T10:00:00.000Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tMentioned).toBe('2025-09-03T10:00:00.000Z');
    }
  });

  it('validates KnowledgeNode without tMentioned (backward compat)', () => {
    const result = knowledgeNodeSchema.safeParse(baseNode);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tMentioned).toBeUndefined();
    }
  });

  it('validates KnowledgeNode with both tMentioned and tValid', () => {
    const result = knowledgeNodeSchema.safeParse({
      ...baseNode,
      tMentioned: '2025-09-03T10:00:00.000Z',
      tValid: '2025-08-15T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tMentioned).toBe('2025-09-03T10:00:00.000Z');
      expect(result.data.tValid).toBe('2025-08-15T00:00:00.000Z');
    }
  });
});

// ── salience field on KnowledgeNode ──────────────────────────────────────────

describe('knowledgeNodeSchema — salience field', () => {
  const baseNode = {
    id: 'node-1',
    projectId: 'proj-1',
    text: 'Some fact',
    tags: [],
    source: 'task_completed',
    timestamp: 1700000000000,
  };

  it('validates KnowledgeNode with salience set to valid value', () => {
    const result = knowledgeNodeSchema.safeParse({ ...baseNode, salience: 7 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.salience).toBe(7);
    }
  });

  it('validates KnowledgeNode without salience (backward compat)', () => {
    const result = knowledgeNodeSchema.safeParse(baseNode);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.salience).toBeUndefined();
    }
  });

  it('rejects salience below 0', () => {
    const result = knowledgeNodeSchema.safeParse({ ...baseNode, salience: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects salience above 10', () => {
    const result = knowledgeNodeSchema.safeParse({ ...baseNode, salience: 11 });
    expect(result.success).toBe(false);
  });

  it('accepts salience at boundary values 0 and 10', () => {
    const resultMin = knowledgeNodeSchema.safeParse({ ...baseNode, salience: 0 });
    const resultMax = knowledgeNodeSchema.safeParse({ ...baseNode, salience: 10 });
    expect(resultMin.success).toBe(true);
    expect(resultMax.success).toBe(true);
  });
});

// ── getSalience helper ────────────────────────────────────────────────────────

describe('getSalience', () => {
  const makeNode = (salience?: number): KnowledgeNode => ({
    id: 'node-1',
    projectId: 'proj-1',
    text: 'Some fact',
    tags: [],
    source: 'task_completed',
    timestamp: 1700000000000,
    salience,
  });

  it('returns the node salience when present', () => {
    expect(getSalience(makeNode(8))).toBe(8);
  });

  it('returns 5 when salience is absent (default)', () => {
    expect(getSalience(makeNode(undefined))).toBe(5);
  });

  it('returns 0 when salience is 0', () => {
    expect(getSalience(makeNode(0))).toBe(0);
  });

  it('returns 10 when salience is 10', () => {
    expect(getSalience(makeNode(10))).toBe(10);
  });

  it('clamps salience above 10 to 10', () => {
    // Bypass schema validation by casting — testing the helper directly
    expect(getSalience(makeNode(15) as unknown as KnowledgeNode)).toBe(10);
  });

  it('clamps salience below 0 to 0', () => {
    expect(getSalience(makeNode(-3) as unknown as KnowledgeNode)).toBe(0);
  });
});

// ── getEffectiveDate helper ───────────────────────────────────────────────────

describe('getEffectiveDate', () => {
  it('returns tValid when both tValid and tMentioned are set', () => {
    const result = getEffectiveDate({
      tValid: '2025-08-15T00:00:00.000Z',
      tMentioned: '2025-09-03T10:00:00.000Z',
    });
    expect(result).toBe('2025-08-15T00:00:00.000Z');
  });

  it('returns tMentioned when tValid is absent but tMentioned is set', () => {
    const result = getEffectiveDate({
      tMentioned: '2025-09-03T10:00:00.000Z',
    });
    expect(result).toBe('2025-09-03T10:00:00.000Z');
  });

  it('returns undefined when neither tValid nor tMentioned is set', () => {
    const result = getEffectiveDate({});
    expect(result).toBeUndefined();
  });

  it('returns tValid when only tValid is set', () => {
    const result = getEffectiveDate({
      tValid: '2025-01-01T00:00:00.000Z',
    });
    expect(result).toBe('2025-01-01T00:00:00.000Z');
  });
});

// ── PropositionExtractionResult schema ────────────────────────────────────────

describe('propositionExtractionResultSchema', () => {
  it('validates a valid PropositionExtractionResult with all fields', () => {
    const result = propositionExtractionResultSchema.safeParse({
      propositions: [
        {
          text: 'User prefers dark mode for all applications',
          emotionalColoring: 'neutral',
          temporalMarkers: ['always', 'for all applications'],
        },
      ],
      entities: [
        { name: 'dark mode', entityType: 'concept' },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.propositions).toHaveLength(1);
      expect(result.data.propositions[0]!.text).toBe('User prefers dark mode for all applications');
      expect(result.data.propositions[0]!.emotionalColoring).toBe('neutral');
      expect(result.data.propositions[0]!.temporalMarkers).toEqual(['always', 'for all applications']);
      expect(result.data.entities).toHaveLength(1);
      expect(result.data.entities[0]!.name).toBe('dark mode');
      expect(result.data.entities[0]!.entityType).toBe('concept');
    }
  });

  it('validates a PropositionExtractionResult with minimal fields', () => {
    const result = propositionExtractionResultSchema.safeParse({
      propositions: [
        { text: 'Some proposition' },
      ],
      entities: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.propositions[0]!.emotionalColoring).toBeUndefined();
      expect(result.data.propositions[0]!.temporalMarkers).toBeUndefined();
    }
  });

  it('validates entity types: person, place, concept, object, event', () => {
    const entityTypesForPropositions = ['person', 'place', 'concept', 'object', 'event'] as const;
    for (const entityType of entityTypesForPropositions) {
      const result = propositionExtractionResultSchema.safeParse({
        propositions: [],
        entities: [{ name: `A ${entityType}`, entityType }],
      });
      expect(result.success, `entity type '${entityType}' should be valid`).toBe(true);
    }
  });

  it('rejects invalid entity types in PropositionExtractionResult', () => {
    const result = propositionExtractionResultSchema.safeParse({
      propositions: [],
      entities: [{ name: 'test', entityType: 'invalid_type' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty proposition text', () => {
    const result = propositionExtractionResultSchema.safeParse({
      propositions: [{ text: '' }],
      entities: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty entity name', () => {
    const result = propositionExtractionResultSchema.safeParse({
      propositions: [],
      entities: [{ name: '', entityType: 'person' }],
    });
    expect(result.success).toBe(false);
  });
});

// ── Zettelkasten: fragment entity type ──────────────────────────────────────

describe('entityTypes — fragment', () => {
  it('includes fragment as a valid entity type', () => {
    expect(entityTypes).toContain('fragment');
  });

  it('validates KnowledgeNode with entityType fragment', () => {
    const result = knowledgeNodeSchema.safeParse({
      id: 'frag-1',
      projectId: 'proj-1',
      text: 'User discussed their approach to time management with multiple strategies',
      tags: ['productivity'],
      source: 'session_consolidation',
      timestamp: 1700000000000,
      entityType: 'fragment',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entityType).toBe('fragment');
    }
  });

  it('still validates proposition entity type (backward compat)', () => {
    const result = knowledgeNodeSchema.safeParse({
      id: 'prop-1',
      projectId: 'proj-1',
      text: 'User prefers dark mode',
      tags: [],
      source: 'session_consolidation',
      timestamp: 1700000000000,
      entityType: 'proposition',
    });
    expect(result.success).toBe(true);
  });
});

// ── Zettelkasten: new edge relation types ───────────────────────────────────

describe('edgeRelationTypes — Zettelkasten relations', () => {
  it('includes MECE taxonomy edge types', () => {
    const meceTypes = [
      'follows', 'causes', 'elaborates', 'synthesizes',
      'supports', 'contradicts', 'questions', 'supersedes', 'parallels',
    ] as const;
    for (const edgeType of meceTypes) {
      expect(edgeRelationTypes, `edgeRelationType '${edgeType}' should be present`).toContain(edgeType);
    }
  });

  it('does not include removed legacy types', () => {
    expect(edgeRelationTypes).not.toContain('extends');
    expect(edgeRelationTypes).not.toContain('refines');
    expect(edgeRelationTypes).not.toContain('related_to');
  });

  it('still includes all pre-existing edge relation types after additions', () => {
    const preExisting = [
      'temporal_before', 'temporal_after', 'caused_by',
      'same_topic', 'elaborates', 'contradicts', 'contains', 'occurred_during',
      'mentions', 'sequence',
    ] as const;
    for (const edgeType of preExisting) {
      expect(edgeRelationTypes, `edgeRelationType '${edgeType}' should still be present`).toContain(edgeType);
    }
  });
});

// ── Zettelkasten: sessionAnalysisResultSchema — fragments field ─────────────

describe('sessionAnalysisResultSchema — fragments', () => {
  const baseSessionAnalysis = {
    title: 'Test Session',
    summary: 'A test session about productivity',
    topicSegments: [
      { title: 'Intro', startMessageIndex: 0, endMessageIndex: 5 },
    ],
    entityClassifications: [
      { entityText: 'Pomodoro', classification: 'permanent_fact' as const },
    ],
  };

  it('validates session analysis with fragments field', () => {
    const result = sessionAnalysisResultSchema.safeParse({
      ...baseSessionAnalysis,
      fragments: [
        {
          title: 'Time Management Strategies',
          content: 'User discussed their approach to time management. They prefer the Pomodoro technique. This involves working in 25-minute focused blocks.',
          entities: ['Pomodoro', 'time management'],
          type: 'insight',
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fragments).toHaveLength(1);
      expect(result.data.fragments![0]!.title).toBe('Time Management Strategies');
      expect(result.data.fragments![0]!.content).toBe(
        'User discussed their approach to time management. They prefer the Pomodoro technique. This involves working in 25-minute focused blocks.'
      );
      expect(result.data.fragments![0]!.entities).toEqual(['Pomodoro', 'time management']);
      expect(result.data.fragments![0]!.type).toBe('insight');
    }
  });

  it('validates session analysis without fragments (backward compat)', () => {
    const result = sessionAnalysisResultSchema.safeParse(baseSessionAnalysis);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fragments).toBeUndefined();
    }
  });

  it('validates session analysis with both propositions and fragments', () => {
    const result = sessionAnalysisResultSchema.safeParse({
      ...baseSessionAnalysis,
      propositions: [
        {
          text: 'User prefers Pomodoro technique',
          entities: ['Pomodoro'],
        },
      ],
      fragments: [
        {
          title: 'Productivity Methods',
          content: 'The user has tried several productivity methods. Pomodoro is the preferred one. They use 25-minute blocks.',
          entities: ['Pomodoro'],
          type: 'fact',
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.propositions).toHaveLength(1);
      expect(result.data.fragments).toHaveLength(1);
    }
  });

  it('validates fragment with empty entities array', () => {
    const result = sessionAnalysisResultSchema.safeParse({
      ...baseSessionAnalysis,
      fragments: [
        {
          title: 'Observation',
          content: 'A general observation about the session without specific entities mentioned.',
          entities: [],
          type: 'insight',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects fragment with empty title', () => {
    const result = sessionAnalysisResultSchema.safeParse({
      ...baseSessionAnalysis,
      fragments: [
        {
          title: '',
          content: 'Some content here.',
          entities: [],
          type: 'fact',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects fragment with empty content', () => {
    const result = sessionAnalysisResultSchema.safeParse({
      ...baseSessionAnalysis,
      fragments: [
        {
          title: 'Valid Title',
          content: '',
          entities: [],
          type: 'fact',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects fragment with invalid type', () => {
    const result = sessionAnalysisResultSchema.safeParse({
      ...baseSessionAnalysis,
      fragments: [
        {
          title: 'Valid Title',
          content: 'Valid content here.',
          entities: [],
          type: 'unknown_type',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('accepts all valid fragment types', () => {
    const validTypes = ['fact', 'event', 'belief', 'plan', 'problem', 'insight'] as const;
    for (const type of validTypes) {
      const result = sessionAnalysisResultSchema.safeParse({
        ...baseSessionAnalysis,
        fragments: [
          {
            title: 'Test Fragment',
            content: 'Content for this fragment.',
            entities: [],
            type,
          },
        ],
      });
      expect(result.success).toBe(true);
    }
  });
});

// ── Zettelkasten: fragmentTitle on KnowledgeNode (Zod schema) ───────────────

describe('knowledgeNodeSchema — fragmentTitle field', () => {
  const baseNode = {
    id: 'node-1',
    projectId: 'proj-1',
    text: 'Some knowledge fragment',
    tags: [],
    source: 'session_consolidation',
    timestamp: 1700000000000,
  };

  it('validates KnowledgeNode with fragmentTitle set', () => {
    const result = knowledgeNodeSchema.safeParse({
      ...baseNode,
      entityType: 'fragment',
      fragmentTitle: 'Time Management Strategies',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fragmentTitle).toBe('Time Management Strategies');
    }
  });

  it('validates KnowledgeNode without fragmentTitle (backward compat)', () => {
    const result = knowledgeNodeSchema.safeParse(baseNode);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fragmentTitle).toBeUndefined();
    }
  });
});

// ── Zettelkasten: fragmentTitle on ArangoDB KnowledgeNode interface ─────────

describe('ArangoDB KnowledgeNode — fragmentTitle field', () => {
  it('accepts fragmentTitle on KnowledgeNode interface', () => {
    const node: ArangoKnowledgeNode = {
      _key: 'node-1',
      content: 'Some knowledge fragment',
      embedding: [0.1, 0.2, 0.3],
      timestamp: '2025-01-01T00:00:00.000Z',
      source: 'session_consolidation',
      contextId: 'proj-1',
      entityType: 'fragment',
      fragmentTitle: 'Time Management Strategies',
    };
    expect(node.fragmentTitle).toBe('Time Management Strategies');
  });

  it('accepts KnowledgeNode without fragmentTitle (backward compat)', () => {
    const node: ArangoKnowledgeNode = {
      _key: 'node-1',
      content: 'Some knowledge',
      embedding: [0.1, 0.2, 0.3],
      timestamp: '2025-01-01T00:00:00.000Z',
      source: 'session_consolidation',
      contextId: 'proj-1',
    };
    expect(node.fragmentTitle).toBeUndefined();
  });

  it('accepts fragmentTitle on KnowledgeNodeInsert interface', () => {
    const insert: KnowledgeNodeInsert = {
      content: 'Some knowledge fragment',
      embedding: [0.1, 0.2, 0.3],
      source: 'session_consolidation',
      contextId: 'proj-1',
      entityType: 'fragment',
      fragmentTitle: 'Time Management Strategies',
    };
    expect(insert.fragmentTitle).toBe('Time Management Strategies');
  });
});
