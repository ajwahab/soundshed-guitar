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

export interface DeduplicationOptions {
  preferredResourceIds?: Iterable<string>;
}

/**
 * Normalizes a file path for comparison.
 * Converts to lowercase and normalizes separators.
 */
function normalizeFilePath(path: string): string {
  return path.toLowerCase().replace(/\\/g, "/");
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function parseNamArchitecture(value: string): "A1" | "A2" | "" {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  if (normalized === "2" || normalized === "a2" || normalized.includes("slimmable")) {
    return "A2";
  }
  if (normalized === "1" || normalized === "a1" || normalized.includes("wavenet")) {
    return "A1";
  }

  return "";
}

function getNamArchitecture(resource: LibraryResource): "A1" | "A2" | "" {
  const metadata = resource.metadata ?? {};
  const architectureToken =
    metadata.architectureVersion
    ?? metadata.architecture_version
    ?? metadata.architecture
    ?? "";

  return parseNamArchitecture(architectureToken);
}

/**
 * Determines if a resource should be considered as the "canonical" entry.
 * Priority:
 * 1. !fileMissing
 * 2. For same-named NAM duplicates, prefer A2 architecture over A1
 * 3. richer metadata
 * 4. alphabetical by id
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

  // For same-named NAM duplicates, prefer A2 variants over A1.
  if (normalizeName(candidate.name || candidate.id) === normalizeName(current.name || current.id)) {
    const candidateArchitecture = getNamArchitecture(candidate);
    const currentArchitecture = getNamArchitecture(current);
    if (candidateArchitecture !== currentArchitecture) {
      if (candidateArchitecture === "A2" && currentArchitecture === "A1") {
        return true;
      }
      if (candidateArchitecture === "A1" && currentArchitecture === "A2") {
        return false;
      }
    }
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
  resources: LibraryResource[],
  options?: DeduplicationOptions,
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
  const preferredResourceIds = new Set<string>();
  if (options?.preferredResourceIds) {
    for (const preferredId of options.preferredResourceIds) {
      if (preferredId) {
        preferredResourceIds.add(preferredId);
      }
    }
  }

  for (const group of groups.values()) {
    if (group.length === 0) {
      continue;
    }

    const preferredGroupEntries = group.filter((resource) => preferredResourceIds.has(resource.id));
    const candidatePool = preferredGroupEntries.length > 0 ? preferredGroupEntries : group;

    // Pick canonical entry from the selected candidate pool.
    let canonical = candidatePool[0];
    for (let i = 1; i < candidatePool.length; i++) {
      const candidate = candidatePool[i];
      if (isCanonicalCandidate(candidate, canonical)) {
        canonical = candidate;
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
