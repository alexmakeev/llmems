// src/shared/remap.ts
// Pure helpers for ID remapping used by clone operations.

/**
 * Remap a source mem's chunk_ids array to the new target chunk IDs.
 * Throws if any source chunk ID has no mapping (integrity violation).
 *
 * @param sourceChunkIds - original chunk ID array from the source mem (may be null)
 * @param chunkIdMap - Map from old chunk ID → new chunk ID
 * @returns remapped array, or null if sourceChunkIds is null
 */
export function remapChunkIds(
  sourceChunkIds: number[] | null,
  chunkIdMap: Map<number, number>,
): number[] | null {
  if (sourceChunkIds === null) return null;
  return sourceChunkIds.map((oldId) => {
    const newId = chunkIdMap.get(oldId);
    if (newId === undefined) {
      throw new Error(
        `chunk_ids remapping failed: source chunk ID ${oldId} has no mapping in chunkIdMap`,
      );
    }
    return newId;
  });
}
