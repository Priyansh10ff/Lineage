import type { Doc } from '@lineage/core';

export type SourceFormat = 'markdown' | 'text' | 'chatgpt' | 'claude' | 'chat-markdown' | 'pdf' | 'code';

export interface IngestInput {
  /** Original file name, used for format detection and the workspace path. */
  name: string;
  data: Uint8Array | string;
}

export interface IngestedArtifact {
  /** Suggested workspace path, e.g. `chats/chatgpt/rag-basics-1a2b3c4d`. */
  path: string;
  doc: Doc;
  format: SourceFormat;
  /** The file it came from. One export file can produce many artifacts. */
  sourceName: string;
}

export interface IngestResult {
  artifacts: IngestedArtifact[];
  /** Files skipped or partially parsed, with the reason. */
  warnings: string[];
}

/** Splits source code into symbol units. Supplied by the caller so the browser build stays free of wasm loading. */
export interface CodeParser {
  /** Returns `null` if the language isn't supported, so the caller falls back to block chunking. */
  parse(path: string, source: string): Promise<Doc | null>;
}

export interface IngestOptions {
  codeParser?: CodeParser;
  /** Prefix for all generated paths. */
  prefix?: string;
  /** Files above this size inside archives are skipped. Default 1 MB. */
  maxFileBytes?: number;
}
