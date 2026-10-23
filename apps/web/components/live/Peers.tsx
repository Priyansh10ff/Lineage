'use client';

import type { PresenceUser, PresenceView } from '@lineage/realtime';
import Link from 'next/link';
import { useLive, type Peer } from './LiveProvider';

export function PeerAvatar({ user, size = 28, ring }: { user: Pick<PresenceUser, 'initials' | 'color' | 'name'>; size?: number; ring?: string }) {
  return (
    <span
      aria-hidden
      title={user.name}
      className="inline-grid shrink-0 place-items-center rounded-full font-extrabold text-ink"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.38),
        background: user.color,
        boxShadow: ring ? `0 0 0 2px ${ring}` : undefined,
      }}
    >
      {user.initials}
    </span>
  );
}

export function activity(view: PresenceView): string {
  const on = view.branch === 'main' ? '' : ` on ${view.branch}`;
  switch (view.page) {
    case 'edit':
      return `editing ${view.path ?? 'a new note'}${on}`;
    case 'file':
      return `reading ${view.path}${on}`;
    case 'history':
      return `looking at history${on}`;
    case 'compare':
      return 'comparing lines';
    case 'merge':
      return 'reviewing merges';
    case 'import':
      return 'importing files';
    case 'ask':
      return 'asking the workspace';
    default:
      return `on the map${on}`;
  }
}

function Facepile({ peers, ring, max = 4 }: { peers: Peer[]; ring: string; max?: number }) {
  const shown = peers.slice(0, max);
  return (
    <span className="flex items-center">
      {shown.map((p, i) => (
        <span key={p.user.id} className={i ? '-ml-1.5' : ''}>
          <PeerAvatar user={p.user} ring={ring} />
        </span>
      ))}
      {peers.length > max && <span className="ml-1.5 text-sm font-bold">+{peers.length - max}</span>}
    </span>
  );
}

/** Who else is in the workspace, plus the connection state, for the dark header. */
export function HeaderPeers() {
  const live = useLive();
  if (!live) return null;
  const { peers, status } = live;
  const label = peers.length
    ? `Here now: ${peers.map((p) => `${p.user.name}, ${activity(p.view)}`).join('; ')}`
    : status === 'live'
      ? 'Live. Nobody else is here right now.'
      : status === 'connecting'
        ? 'Connecting to live updates'
        : 'Live updates are offline';
  return (
    <div className="flex min-h-10 items-center gap-2.5" title={label} aria-label={label} role="status">
      {peers.length > 0 && <Facepile peers={peers} ring="#17181C" />}
      <span className="flex items-center gap-1.5 text-sm text-header-muted">
        <span
          aria-hidden
          className={`inline-block size-2 rounded-full ${status === 'live' ? 'bg-[#4ADE80]' : status === 'connecting' ? 'bg-[#F4A340]' : 'bg-[#6B6E78]'}`}
        />
        {status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Offline'}
      </span>
    </div>
  );
}

/** People currently riding a line, for the map legend. */
export function LanePeers({ branch }: { branch: string }) {
  const live = useLive();
  const riders = live?.peers.filter((p) => p.view.branch === branch) ?? [];
  if (!riders.length) return null;
  return (
    <span className="ml-1 flex items-center" title={riders.map((p) => `${p.user.name}, ${activity(p.view)}`).join('\n')}>
      <Facepile peers={riders} ring="#F1F5FF" max={3} />
      <span className="sr-only">{riders.map((p) => p.user.name).join(', ')} on this line</span>
    </span>
  );
}

/** "Bob is editing this file" with a way to join, for the file page. */
export function EditingNow({ path, branch, href, className = '' }: { path: string; branch: string; href: string; className?: string }) {
  const live = useLive();
  const editors = live?.peers.filter((p) => p.view.page === 'edit' && p.view.path === path && p.view.branch === branch) ?? [];
  if (!editors.length) return null;
  const names = editors.map((p) => p.user.name);
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded border-2 border-ink bg-white px-4 py-2.5 ${className}`} role="status">
      <Facepile peers={editors} ring="#FFFFFF" />
      <span>
        <b>{who}</b> {editors.length === 1 ? 'is' : 'are'} editing this file right now.
      </span>
      <Link href={href} className="font-bold">
        Join the draft
      </Link>
    </div>
  );
}
