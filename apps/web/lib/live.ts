import 'server-only';
import type { PresenceUser } from '@lineage/realtime';
import { collabSecret, signToken } from '@lineage/realtime/token';
import type { MockUser } from './users';

export interface LiveConnection {
  /** Collaboration server URL, or `null` to use this host on port 1234. */
  url: string | null;
  token: string;
  user: PresenceUser;
}

export function presenceUser(u: MockUser): PresenceUser {
  return { id: u.id, name: u.name, initials: u.initials, color: u.color, accent: u.accent, kind: u.kind ?? 'human' };
}

/** What a page needs to join a workspace's live rooms as this user. */
export function liveConnection(user: MockUser, slug: string): LiveConnection {
  const presence = presenceUser(user);
  return {
    url: process.env.LINEAGE_COLLAB_URL ?? null,
    token: signToken({ user: presence, ws: slug }, collabSecret()),
    user: presence,
  };
}
