/**
 * Resource Deduplication Utilities
 * 
 * Deduplicates resources by content hash and file path to eliminate
 * duplicate entries that refer to the same file but exist in different
 * storage locations.
 */

import type { LibraryResource } from "./types.js";

export interface DeduplicationResult {
  deduped: LibraryResource[];
  aliasById: Map<string, string>;
}

/**
 * Normalizes a file path for comparison.
 * Converts to lowercase and normalizes separators.
 */
function normalizeFilePath(path: string): string {
  return path.toLowerCase().replace(/\\/g, "/");
}

/**
 * Determines if a resource should be considered as the "canonical" entry.
 * Priority: !fileMissing > has more metadata > alphabetically first by id
 */
function isCanonicalCandidate(
  candidate: LibraryResource,
  current: LibraryResource
): boolean {
  // Prefer entries where file exists
  const candidateFileExists = !candidate.fileMissing;
  const currentFileExists = !current.fileMissing;
  if (candidateFileExists !== currentFileExists) {
    return candidateFileExists;
  }

  // Prefer entries with richer metadata (tags or description)
  const candidateMetadataCount =
    (candidate.tags?.length ?? 0) + (candidate.description?.length ?? 0);
  const currentMetadataCount =
    (current.tags?.length ?? 0) + (current.description?.length ?? 0);
  if (candidateMetadataCount !== currentMetadataCount) {
    return candidateMetadataCount > currentMetadataCount;
  }

  // Fallback: alphabetical by ID for deterministic behavior
  return candidate.id.localeCompare(current.id) < 0;
}

/**
 * Deduplicates a list of resources by content hash and file path.
 * 
 * Strategy:
 * 1. Group by normalized hash (primary key, case-insensitive)
 * 2. For entries with no hash, group by normalized filePath (fallback)
 * 3. Within each group, select a canonical entry by priority
 * 4. Return deduped list and a mapping (aliasById) of hidden IDs to canonical IDs
 * 
 * @param resources Full list of library resources
 * @returns Object with deduped list and alias mapping for backward compatibility
 */
export function deduplicateResourcesByHashAndPath(
  resources: LibraryResource[]
): DeduplicationResult {
  if (!resources.length) {
    return {
      deduped: [],
      aliasById: new Map(),
    };
  }

  // Group resources by normalized hash or normalized filePath
  const groups = new Map<string, LibraryResource[]>();

  for (const resource of resources) {
    let groupKey: string;

    // Primary key: normalized hash (if available)
    if (resource.hash) {
      groupKey = `hash:${resource.hash.toLowerCase()}`;
    } else {
      // Fallback: normalized filePath
      groupKey = `path:${normalizeFilePath(resource.filePath)}`;
    }

    const group = groups.get(groupKey) ?? [];
    group.push(resource);
    groups.set(groupKey, group);
  }

  // Select canonical entry from each group and build alias mapping
  const deduped: LibraryResource[] = [];
  const aliasById = new Map<string, string>();

  for (const group of groups.values()) {
    if (group.length === 0) {
      continue;
    }

    // Sort group to find canonical entry
    let canonical = group[0];
    for (let i = 1; i < group.length; i++) {
      if (isCanonicalCandidate(group[i], canonical)) {
        canonical = group[i];
      }
    }

    deduped.push(canonical);

    // Map all other IDs in group to canonical ID
    for (const resource of group) {
      if (resource.id !== canonical.id) {
        aliasById.set(resource.id, canonical.id);
      }
    }
  }

  return {
    deduped,
    aliasById,
  };
}

/**
 * Resolves a resource ID through the alias mapping.
 * If the ID is aliased, returns the canonical ID; otherwise returns the original ID.
 * 
 * @param resourceId The potentially-aliased resource ID
 * @param aliasById Alias mapping from deduplication
 * @returns The canonical resource ID
 */
export function resolveResourceIdAlias(
  resourceId: string,
  aliasById: Map<string, string>
): string {
  return aliasById.get(resourceId) ?? resourceId;
}
