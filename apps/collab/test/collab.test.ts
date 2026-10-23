import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { parseProse, type Doc } from '@lineage/core';
import { DRAFT_META, DRAFT_TEXT, draftRoom, parseServerMessage, workspaceRoom, type PresenceUser, type ServerMessage } from '@lineage/realtime';
import { signToken } from '@lineage/realtime/token';
import { WorkspaceRegistry, type Workspace } from '@lineage/store-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { createCollabServer, DraftFiles, newFileTemplate, type CollabServer } from '../src/index.js';

const SECRET = 'test-secret';
const alice: PresenceUser = { id: 'alice', name: 'Alice', initials: 'AL', color: '#F4A340', kind: 'human' };
const bob: PresenceUser = { id: 'bob', name: 'Bob', initials: 'BO', color: '#9FD3C1', kind: 'human' };
const NOTES = '# Notes\n\nFirst paragraph.\n\nSecond paragraph.';

let dataDir: string;
let registry: WorkspaceRegistry;
let ws: Workspace;
let collab: CollabServer;
let url: string;
const open: HocuspocusProvider[] = [];

async function until<T>(fn: () => T | undefined | false, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 15));
  }
}

function connect(user: PresenceUser, name: string, opts: { slug?: string; token?: string; onStateless?: (m: ServerMessage) => void } = {}) {
  let failed: string | undefined;
  const provider = new HocuspocusProvider({
    url,
    name,
    token: opts.token ?? signToken({ user, ws: opts.slug ?? 'demo' }, SECRET),
    WebSocketPolyfill: WebSocket,
    onAuthenticationFailed: ({ reason }) => {
      failed = reason || 'failed';
    },
    onStateless: ({ payload }) => {
      const m = parseServerMessage(payload);
      if (m) opts.onStateless?.(m);
    },
  } as ConstructorParameters<typeof HocuspocusProvider>[0]);
  open.push(provider);
  return {
    provider,
    text: () => provider.document.getText(DRAFT_TEXT),
    meta: () => provider.document.getMap<unknown>(DRAFT_META),
    synced: () => until(() => provider.isSynced),
    failed: () => until(() => failed),
  };
}

const commit = (path: string, doc: Doc, author = { id: 'bob', name: 'Bob' }) =>
  ws.repo.commit({ branch: 'main', author, message: `Edit ${path}`, changes: { [path]: doc } });

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'lineage-collab-'));
  registry = new WorkspaceRegistry(dataDir);
  ws = await registry.create({ name: 'Demo', slug: 'demo', author: { id: 'alice', name: 'Alice' } });
  await commit('docs/notes.md', parseProse(NOTES), { id: 'alice', name: 'Alice' });
  collab = createCollabServer({ dataDir, secret: SECRET, port: 0, quiet: true, pollMs: 100, debounce: 30 });
  url = `ws://127.0.0.1:${await collab.listen()}`;
});

afterEach(async () => {
  for (const p of open.splice(0)) p.destroy();
  await collab.close();
});

describe('authentication', () => {
  it('refuses bad tokens and tokens for another workspace', async () => {
    const forged = connect(alice, workspaceRoom('demo'), { token: 'nope' });
    expect(await forged.failed()).toBeTruthy();
    const elsewhere = connect(alice, workspaceRoom('demo'), { slug: 'other' });
    expect(await elsewhere.failed()).toBeTruthy();
    const unknown = connect(alice, 'draft:demo:main');
    expect(await unknown.failed()).toBeTruthy();
  });

  it('stamps presence with the identity from the token', async () => {
    const a = connect(alice, workspaceRoom('demo'));
    const b = connect(bob, workspaceRoom('demo'));
    await Promise.all([a.synced(), b.synced()]);
    a.provider.setAwarenessField('user', { ...bob, name: 'Not Alice' });
    a.provider.setAwarenessField('view', { page: 'map', branch: 'main' });
    const seen = await until(() =>
      [...b.provider.awareness!.getStates().values()].find((s) => s['view']?.page === 'map' && s['user']),
    );
    expect(seen['user']).toEqual(alice);
  });
});

describe('drafts', () => {
  const room = draftRoom('demo', 'main', 'docs/notes.md');

  it('seeds from the branch head and syncs edits between people', async () => {
    const head = (await ws.repo.branches())['main'];
    const a = connect(alice, room);
    const b = connect(bob, room);
    await Promise.all([a.synced(), b.synced()]);
    expect(a.text().toString()).toBe(NOTES);
    expect(a.meta().get('base')).toBe(head);
    expect(a.meta().get('isNew')).toBe(false);

    a.text().insert(a.text().length, '\n\nThird, from Alice.');
    b.text().insert(0, '');
    b.text().insert(NOTES.indexOf('Second'), 'A ');
    await until(() => a.text().toString() === b.text().toString() && a.text().toString().includes('Third') && a.text().toString().includes('A Second'));
  });

  it('starts a new file from a template', async () => {
    const c = connect(alice, draftRoom('demo', 'main', 'docs/reading-list.md'));
    await c.synced();
    expect(c.text().toString()).toBe(newFileTemplate('docs/reading-list.md'));
    expect(c.text().toString()).toMatch(/^# Reading list/);
    expect(c.meta().get('isNew')).toBe(true);
  });

  it('refuses files that are not prose', async () => {
    await commit('code/a.py', { kind: 'code', units: [{ type: 'line', text: 'print(1)\n' }] });
    const c = connect(alice, draftRoom('demo', 'main', 'code/a.py'));
    await new Promise((r) => setTimeout(r, 300));
    expect(c.provider.isSynced).toBe(false);
    expect(c.text().length).toBe(0);
  });

  it('follows the branch when the draft has no edits of its own', async () => {
    const a = connect(alice, room);
    await a.synced();
    const next = await commit('docs/notes.md', parseProse(`${NOTES}\n\nAdded by Bob elsewhere.`));
    await until(() => a.meta().get('base') === next);
    expect(a.text().toString()).toContain('Added by Bob elsewhere.');
    expect(a.meta().get('head')).toBe(next);
  });

  it('keeps edits when the branch moves, and records the new head', async () => {
    const a = connect(alice, room);
    await a.synced();
    const base = a.meta().get('base');
    a.text().insert(a.text().length, '\n\nAlice is mid-thought');
    await new Promise((r) => setTimeout(r, 100));
    const next = await commit('docs/notes.md', parseProse(`# Notes\n\nFirst paragraph, revised by Bob.\n\nSecond paragraph.`));
    await until(() => a.meta().get('head') === next);
    expect(a.meta().get('base')).toBe(base);
    expect(a.text().toString()).toContain('Alice is mid-thought');
    expect(a.text().toString()).not.toContain('revised by Bob');
  });

  it('adopts a commit of its own text without flagging it as moved', async () => {
    const a = connect(alice, room);
    await a.synced();
    a.text().insert(a.text().length, '\n\nCommitted soon.');
    const next = await commit('docs/notes.md', parseProse(a.text().toString()));
    await until(() => a.meta().get('base') === next && a.meta().get('head') === next);
  });

  it('keeps uncommitted text on disk across sessions, and drops it once committed', async () => {
    const files = new DraftFiles(dataDir);
    const file = files.file('demo', 'main', 'docs/notes.md');
    const a = connect(alice, room);
    await a.synced();
    a.text().insert(a.text().length, '\n\nUnsaved thought.');
    await until(() => existsSync(file));
    a.provider.destroy();
    await until(() => collab.server.hocuspocus.getDocumentsCount() === 0);

    const again = connect(bob, room);
    await again.synced();
    expect(again.text().toString()).toContain('Unsaved thought.');

    const next = await commit('docs/notes.md', parseProse(again.text().toString()));
    await until(() => again.meta().get('base') === next);
    again.provider.destroy();
    await until(() => !existsSync(file));
  });

  it('marks the draft when its branch is deleted', async () => {
    await ws.repo.createBranch('side', 'main');
    const a = connect(alice, draftRoom('demo', 'side', 'docs/notes.md'));
    await a.synced();
    await ws.repo.deleteBranch('side');
    await until(() => a.meta().get('gone') === true);
  });
});

describe('branch updates', () => {
  it('tells everyone in the workspace who moved which branch', async () => {
    const got: ServerMessage[] = [];
    const a = connect(alice, workspaceRoom('demo'), { onStateless: (m) => got.push(m) });
    await a.synced();
    const head = await commit('docs/notes.md', parseProse(`${NOTES}\n\nMore.`));
    const msg = await until(() => got.find((m) => m.changes.some((c) => c.to === head)));
    expect(msg.changes).toEqual([expect.objectContaining({ branch: 'main', to: head, author: 'Bob', message: 'Edit docs/notes.md' })]);

    await ws.repo.createBranch('ideas', 'main');
    await until(() => got.some((m) => m.changes.some((c) => c.branch === 'ideas' && c.from === null)));
  });
});

it('reports health over HTTP', async () => {
  const res = await fetch(url.replace('ws://', 'http://') + '/health');
  expect(await res.json()).toMatchObject({ ok: true });
});

// Y is imported so the provider and the test share one Yjs instance.
void Y;
