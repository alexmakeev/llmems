// src/__tests__/services/remap.test.ts
// Unit tests for the chunk ID remapping helper used by clone-memstore.

import { describe, it, expect } from 'vitest';
import { remapChunkIds } from '../../shared/remap.ts';

describe('remapChunkIds', () => {
  it('returns null when sourceChunkIds is null', () => {
    const map = new Map([[1, 100]]);
    expect(remapChunkIds(null, map)).toBeNull();
  });

  it('returns empty array when sourceChunkIds is empty', () => {
    const map = new Map([[1, 100]]);
    expect(remapChunkIds([], map)).toEqual([]);
  });

  it('remaps a single chunk ID correctly', () => {
    const map = new Map([[219, 450]]);
    expect(remapChunkIds([219], map)).toEqual([450]);
  });

  it('remaps multiple chunk IDs in order', () => {
    const map = new Map([
      [210, 301],
      [211, 302],
      [212, 303],
    ]);
    expect(remapChunkIds([210, 211, 212], map)).toEqual([301, 302, 303]);
  });

  it('remaps chunk IDs when source IDs are not contiguous', () => {
    const map = new Map([
      [5, 101],
      [20, 102],
      [999, 103],
    ]);
    expect(remapChunkIds([999, 5, 20], map)).toEqual([103, 101, 102]);
  });

  it('throws when a chunk ID has no mapping', () => {
    const map = new Map([[1, 100]]);
    expect(() => remapChunkIds([1, 2], map)).toThrow(
      /chunk_ids remapping failed.*source chunk ID 2/,
    );
  });

  it('throws when the map is completely empty', () => {
    const map = new Map<number, number>();
    expect(() => remapChunkIds([1], map)).toThrow(/chunk_ids remapping failed/);
  });

  it('correctly handles a single-element array mapping to itself (same ID)', () => {
    const map = new Map([[42, 42]]);
    expect(remapChunkIds([42], map)).toEqual([42]);
  });
});
