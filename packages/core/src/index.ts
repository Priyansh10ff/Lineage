export * from './types.js';
export * from './errors.js';
export { canonicalize, hashObject, sha256Hex } from './hash.js';
export { MemoryStore, type ObjectStore, type RefStore, type Store } from './store.js';
export { normalizeText, similarity, splitSentences, unitKey } from './text.js';
export { parseProse, renderDoc } from './prose.js';
export { align, type AlignOp, type AlignOptions } from './align.js';
export {
  diffDocs,
  diffSegments,
  diffTreeEntries,
  diffWords,
  type DiffStats,
  type DocDiff,
  type FileChange,
  type FileStatus,
  type SegmentChange,
  type UnitChange,
  type WordChange,
} from './diff.js';
export {
  applyResolution,
  mergeDocs,
  mergeText,
  mergeUnits,
  resolveRegion,
  type ConflictChoice,
  type ConflictReason,
  type FileMergeResult,
  type MergeRegion,
} from './merge.js';
export { layoutGraph, type BranchGraph, type GraphEdge, type GraphLane, type GraphNode } from './graph.js';
export {
  Repository,
  validateBranchName,
  type CommitInput,
  type ConflictedFile,
  type FileDiff,
  type LogEntry,
  type MergeDraft,
  type MergeOutcome,
  type MergePreview,
  type RepositoryOptions,
  type TreeDiff,
} from './repository.js';
