import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RefConflictError, Repository, parseProse } from '@lineage/core';
import { describe, expect, it } from 'vitest';
import { FileStore, WorkspaceRegistry } from '../src/index.js';

const me = { id: 'u1', name: 'Me' };
const tmp = () => mkdtempSync(join(tmpdir(), 'lineage-fs-'));

describe('FileStore', () => {
  it('stores objects once and survives a reopen', async () => {
    const dir = tmp();
    const repo = await Repository.init(new FileStore(dir), { author: me });
    await repo.commit({ branch: 'main', author: me, message: 'a', changes: { 'a.md': parseProse('# A\n\nHello.') } });
    await repo.commit({ branch: 'main', author: me, message: 'b', changes: { 'b.md': parseProse('B') } });

    const reopened = new Repository(new FileStore(dir));
    expect((await reopened.log('main')).map((e) => e.commit.message)).toEqual(['b', 'a', 'Initialize workspace']);
    expect((await reopened.readDoc('main', 'a.md'))?.title).toBe('A');
    // init: tree + commit; each commit: blob + tree + commit (a.md is not rewritten).
    expect(await new FileStore(dir).objectCount()).toBe(8);
  });

  it('enforces compare-and-swap on refs, including under concurrency', async () => {
    const store = new FileStore(tmp());
    await store.setRef('refs/heads/main', 'a'.repeat(64), null);
    await expect(store.setRef('refs/heads/main', 'b'.repeat(64), null)).rejects.toThrow(RefConflictError);

    // Ten writers race from the same expected value: exactly one wins.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => store.setRef('refs/heads/main', i.toString(16).repeat(64), 'a'.repeat(64))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await store.listRefs('refs/heads/')).toHaveProperty('refs/heads/main');
  });

  it('rejects malformed hashes instead of touching the filesystem', async () => {
    const store = new FileStore(tmp());
    expect(await store.getObject('../../etc/passwd')).toBeUndefined();
    expect(await store.hasObject('nope')).toBe(false);
  });
});

describe('WorkspaceRegistry', () => {
  it('creates, lists and tracks what each user has seen', async () => {
    const reg = new WorkspaceRegistry(tmp());
    const a = await reg.create({ name: 'Sleep & Memory Study', author: me });
    const b = await reg.create({ name: 'Sleep & Memory Study', author: me });
    expect([a.meta.slug, b.meta.slug]).toEqual(['sleep-memory-study', 'sleep-memory-study-2']);
    expect((await reg.list()).map((m) => m.slug).sort()).toEqual(['sleep-memory-study', 'sleep-memory-study-2']);

    const head = await a.repo.resolve('main');
    await reg.markSeen(a.meta.slug, 'u1', 'main', head);
    expect((await reg.get(a.meta.slug))!.meta.lastSeen).toEqual({ u1: { main: head } });
    expect(await reg.get('../escape')).toBeUndefined();
  });

  it('stages uploads until they are committed', async () => {
    const reg = new WorkspaceRegistry(tmp());
    const { meta } = await reg.create({ name: 'x', author: me });
    const id = await reg.stage(meta.slug, { files: [1, 2] });
    expect(await reg.readStage(meta.slug, id)).toEqual({ files: [1, 2] });
    await reg.dropStage(meta.slug, id);
    expect(await reg.readStage(meta.slug, id)).toBeUndefined();
  });
});
