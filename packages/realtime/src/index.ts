/**
 * The protocol shared by the collaboration server (apps/collab) and the web app: how rooms are
 * named, what each client publishes as presence, and the messages the server pushes.
 *
 * Browser-safe: no Node imports here. Token signing lives in `@lineage/realtime/token`.
 */

/** Who a connection belongs to. Set by the server from the signed token, never trusted from the client. */
export interface PresenceUser {
  id: string;
  name: string;
  initials: string;
  /** Avatar background (light; text on it is dark). */
  color: string;
  /** Stronger shade for cursors and labels with white text. */
  accent?: string;
  kind: 'human' | 'agent';
}

export type PresencePage = 'map' | 'file' | 'edit' | 'history' | 'compare' | 'merge' | 'import' | 'ask';

/** Where a person is in the workspace right now. */
export interface PresenceView {
  page: PresencePage;
  branch: string;
  path?: string;
}

/** Awareness state published in a workspace room. */
export interface PresenceState {
  user: PresenceUser;
  view: PresenceView;
}

/**
 * Awareness state in a draft room. Shaped for y-codemirror: `color`/`colorLight` paint the
 * caret and selection (the accent shade), `avatar` keeps the avatar background. The caret
 * position itself travels in y-codemirror's `cursor` field.
 */
export interface DraftPresenceState {
  user: PresenceUser & { colorLight: string; avatar: string };
}

/** The `user` field the server stamps on draft-room presence. */
export function draftPresenceUser(user: PresenceUser): DraftPresenceState['user'] {
  const accent = user.accent ?? user.color;
  return { ...user, color: accent, colorLight: lighten(accent, 0.2), avatar: user.color };
}

/** A branch that moved, was created or was deleted. */
export interface RefChange {
  branch: string;
  from: string | null;
  to: string | null;
  /** The new head commit's message and author, when there is one. */
  message?: string;
  author?: string;
}

/** Stateless messages the server broadcasts in a workspace room. */
export type ServerMessage = { type: 'refs'; changes: RefChange[] };

export function parseServerMessage(payload: string): ServerMessage | undefined {
  try {
    const m = JSON.parse(payload) as ServerMessage;
    return m && m.type === 'refs' && Array.isArray(m.changes) ? m : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- rooms

export type Room =
  | { type: 'workspace'; slug: string }
  | { type: 'draft'; slug: string; branch: string; path: string };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Presence and branch updates for one workspace. */
export function workspaceRoom(slug: string): string {
  return `ws:${slug}`;
}

/** The shared working copy of one file on one branch. */
export function draftRoom(slug: string, branch: string, path: string): string {
  return `draft:${slug}:${encodeURIComponent(branch)}:${encodeURIComponent(path)}`;
}

export function parseRoom(name: string): Room | undefined {
  const parts = name.split(':');
  const slug = parts[1];
  if (!slug || !SLUG_RE.test(slug)) return undefined;
  if (parts[0] === 'ws' && parts.length === 2) return { type: 'workspace', slug };
  if (parts[0] === 'draft' && parts.length === 4) {
    try {
      const branch = decodeURIComponent(parts[2]!);
      const path = decodeURIComponent(parts[3]!);
      if (!branch || !path || path.startsWith('/') || path.split('/').includes('..')) return undefined;
      return { type: 'draft', slug, branch, path };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- draft document layout

/** Y.Text holding the draft's markdown. */
export const DRAFT_TEXT = 'body';

/**
 * Y.Map with the draft's bookkeeping, written by the server:
 * - `base`: commit the text was last in sync with (seeded from, or last committed at)
 * - `head`: the branch's current head, so clients can tell when the branch moved on
 * - `isNew`: the file doesn't exist on the branch yet
 * - `gone`: the branch was deleted
 */
export const DRAFT_META = 'meta';

export interface DraftMeta {
  base?: string;
  head?: string;
  isNew?: boolean;
  gone?: boolean;
}

/** A lighter tint of a user color for selection highlights. */
export function lighten(hex: string, alpha = 0.33): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${m[1]}${a}`;
}

/** Minimal edit turning `from` into `to`: common prefix and suffix kept, so cursors elsewhere don't jump. */
export function textPatch(from: string, to: string): { index: number; remove: number; insert: string } | undefined {
  if (from === to) return undefined;
  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)) end++;
  return { index: start, remove: from.length - start - end, insert: to.slice(start, to.length - end) };
}
