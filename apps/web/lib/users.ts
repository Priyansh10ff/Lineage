import type { Author } from '@lineage/core';

/**
 * Mock users until real auth arrives with the hosted database. Switch between them from the
 * header to try concurrent work (a branch as Alice, a review as Priyansh).
 */
export interface MockUser extends Author {
  initials: string;
  /** Avatar background; text on it is always ink. */
  color: string;
  /** Stronger shade for live cursors, readable with white text. */
  accent: string;
}

export const USERS: MockUser[] = [
  { id: 'priyansh', name: 'Priyansh', initials: 'PD', color: '#C9D5F5', accent: '#2F5BEA', kind: 'human' },
  { id: 'alice', name: 'Alice', initials: 'AL', color: '#F4A340', accent: '#B85600', kind: 'human' },
  { id: 'bob', name: 'Bob', initials: 'BO', color: '#9FD3C1', accent: '#0F7A5A', kind: 'human' },
];

export const AGENT: MockUser = { id: 'agent', name: 'Summarizer agent', initials: 'AG', color: '#B7E0D2', accent: '#0B7C70', kind: 'agent' };

export function userById(id: string | undefined): MockUser {
  return USERS.find((u) => u.id === id) ?? (id === AGENT.id ? AGENT : USERS[0]!);
}

/** Plain Author for storing in commits (no UI fields). */
export function asAuthor(u: MockUser): Author {
  return { id: u.id, name: u.name, kind: u.kind ?? 'human' };
}
