/** Hex-encoded sha256 of an object's canonical encoding. */
export type Hash = string;

/** The artifact families Lineage understands. Every artifact is normalized into a {@link Doc}. */
export type ArtifactKind = 'prose' | 'chat' | 'pdf' | 'code';

/**
 * The smallest unit diff and merge reason about. Prose splits into blocks,
 * chats into turns, PDFs into paragraphs (tagged with their page), code into symbols.
 */
export type UnitType =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'quote'
  | 'code_block'
  | 'turn'
  | 'symbol'
  | 'line';

export type MetaValue = string | number | boolean | null;
export type Meta = Record<string, MetaValue>;

export interface Unit {
  type: UnitType;
  text: string;
  /** Free-form structured data, e.g. `{ role: 'user' }` for a chat turn or `{ page: 3 }` for a PDF paragraph. */
  meta?: Meta;
}

/** The normalized, diffable form of any artifact. */
export interface Doc {
  kind: ArtifactKind;
  title?: string;
  meta?: Meta;
  units: Unit[];
}

export interface Author {
  id: string;
  name: string;
  /** Agents get their own branches and go through human merge review. */
  kind?: 'human' | 'agent';
}

export interface BlobObject {
  type: 'blob';
  doc: Doc;
}

/** A flat snapshot of a workspace: path → blob hash. */
export interface TreeObject {
  type: 'tree';
  entries: Record<string, Hash>;
}

export interface CommitObject {
  type: 'commit';
  tree: Hash;
  /** Zero parents for the root commit, two for a merge. */
  parents: Hash[];
  author: Author;
  message: string;
  /** ISO-8601. */
  timestamp: string;
}

export type LineageObject = BlobObject | TreeObject | CommitObject;
