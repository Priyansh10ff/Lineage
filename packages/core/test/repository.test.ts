import { describe, expect, it } from 'vitest';
import {
  InvalidRefNameError,
  NothingToCommitError,
  RefConflictError,
  RefExistsError,
  UnresolvedConflictsError,
  renderDoc,
} from '../src/index.js';
import { alice, bob, chat, makeRepo, md, paper } from './helpers.js';

describe('commits and history', () => {
  it('commits, reads back and logs newest first', async () => {
    const { repo } = await makeRepo();
    const c1 = await repo.commit({ branch: 'main', author: alice, message: 'Add paper', changes: { 'paper.md': md(paper) } });
    const c2 = await repo.commit({
      branch: 'main',
      author: bob,
      message: 'Add chat',
      changes: { 'chats/rag.json': chat(['user', 'hi']) },
    });
    expect(await repo.resolve('main')).toBe(c2);
    expect(await repo.resolve('main~1')).toBe(c1);
    expect(renderDoc((await repo.readDoc('main', 'paper.md'))!)).toBe(renderDoc(md(paper)));
    expect(Object.keys(await repo.getTree('main'))).toEqual(['chats/rag.json', 'paper.md']);

    const log = await repo.log('main');
    expect(log.map((e) => e.commit.message)).toEqual(['Add chat', 'Add paper', 'Initialize workspace']);
    expect((await repo.log('main', { path: 'paper.md' })).map((e) => e.hash)).toEqual([c1]);
  });

  it('stores unchanged files once', async () => {
    const { repo, store } = await makeRepo();
    await repo.commit({ branch: 'main', author: alice, message: 'a', changes: { 'a.md': md(paper), 'b.md': md('B') } });
    const before = store.objectCount;
    await repo.commit({ branch: 'main', author: alice, message: 'b', changes: { 'b.md': md('B2') } });
    // One new blob, one new tree, one new commit. a.md is shared.
    expect(store.objectCount - before).toBe(3);
  });

  it('rejects empty commits and deletes files', async () => {
    const { repo } = await makeRepo();
    await repo.commit({ branch: 'main', author: alice, message: 'a', changes: { 'a.md': md('A') } });
    await expect(repo.commit({ branch: 'main', author: alice, message: 'same', changes: { 'a.md': md('A') } })).rejects.toThrow(
      NothingToCommitError,
    );
    await repo.commit({ branch: 'main', author: alice, message: 'rm', changes: { 'a.md': null } });
    expect(await repo.getTree('main')).toEqual({});
  });

  it('rejects a stale commit instead of overwriting a concurrent one', async () => {
    const { repo } = await makeRepo();
    const head = await repo.resolve('main');
    await repo.commit({ branch: 'main', author: alice, message: 'Alice first', changes: { 'a.md': md('Alice') }, expectedHead: head });
    await expect(
      repo.commit({ branch: 'main', author: bob, message: 'Bob stale', changes: { 'b.md': md('Bob') }, expectedHead: head }),
    ).rejects.toThrow(RefConflictError);
  });

  it('lists what changed since a user last looked', async () => {
    const { repo } = await makeRepo();
    await repo.commit({ branch: 'main', author: alice, message: 'v1', changes: { 'p.md': md(paper) } });
    const lastSeen = await repo.resolve('main');
    await repo.commit({ branch: 'main', author: bob, message: 'v2', changes: { 'p.md': md(paper.replace('40', '45')) } });
    await repo.commit({ branch: 'main', author: bob, message: 'v3', changes: { 'notes.md': md('New notes') } });

    expect((await repo.commitsBetween(lastSeen, 'main')).map((e) => e.commit.message)).toEqual(['v3', 'v2']);
    const d = await repo.diff(lastSeen, 'main');
    expect(d.files.map((f) => [f.path, f.status])).toEqual([
      ['notes.md', 'added'],
      ['p.md', 'modified'],
    ]);
    expect(d.files[1]!.diff.summary).toEqual(['Edited paragraph in "Methods" (1 sentence changed)']);
  });
});

describe('branches', () => {
  it('validates names and refuses duplicates', async () => {
    const { repo } = await makeRepo();
    await repo.createBranch('alice/lit-review', 'main');
    await expect(repo.createBranch('alice/lit-review', 'main')).rejects.toThrow(RefExistsError);
    for (const bad of ['', '../x', 'a..b', '/x', 'x/', 'has space']) {
      await expect(repo.createBranch(bad, 'main')).rejects.toThrow(InvalidRefNameError);
    }
    expect(Object.keys(await repo.branches())).toEqual(['alice/lit-review', 'main']);
  });

  it('fast-forwards when the target has not moved', async () => {
    const { repo } = await makeRepo();
    await repo.createBranch('draft', 'main');
    const c = await repo.commit({ branch: 'draft', author: alice, message: 'x', changes: { 'x.md': md('X') } });
    expect(await repo.merge({ into: 'main', from: 'draft', author: alice })).toEqual({ status: 'fast-forward', head: c });
    expect(await repo.merge({ into: 'main', from: 'draft', author: alice })).toEqual({ status: 'up-to-date', head: c });
  });

  it('finds the merge base', async () => {
    const { repo } = await makeRepo();
    const fork = await repo.commit({ branch: 'main', author: alice, message: 'base', changes: { 'p.md': md(paper) } });
    await repo.createBranch('b', 'main');
    await repo.commit({ branch: 'main', author: alice, message: 'm1', changes: { 'a.md': md('A') } });
    await repo.commit({ branch: 'b', author: bob, message: 'b1', changes: { 'b.md': md('B') } });
    expect(await repo.mergeBase('main', 'b')).toBe(fork);
    expect(await repo.isAncestor(fork, 'b')).toBe(true);
    expect(await repo.isAncestor('b', 'main')).toBe(false);
  });
});

describe('merging branches', () => {
  async function diverged(oursText: string, theirsText: string) {
    const { repo, store } = await makeRepo();
    await repo.commit({ branch: 'main', author: alice, message: 'base', changes: { 'paper.md': md(paper), 'notes.md': md('Notes.') } });
    await repo.createBranch('bob/edits', 'main');
    await repo.commit({ branch: 'main', author: alice, message: 'alice edit', changes: { 'paper.md': md(oursText) } });
    await repo.commit({ branch: 'bob/edits', author: bob, message: 'bob edit', changes: { 'paper.md': md(theirsText) } });
    return { repo, store };
  }

  it('creates a two-parent merge commit for non-overlapping edits', async () => {
    const { repo } = await diverged(
      paper.replace('40 participants', '64 participants'),
      paper.replace('emotional words', 'negative words'),
    );
    const out = await repo.merge({ into: 'main', from: 'bob/edits', author: alice });
    expect(out.status).toBe('merged');
    if (out.status !== 'merged') throw new Error();
    expect(out.autoMerged).toEqual(['paper.md']);
    const commit = await repo.readCommit(out.head);
    expect(commit.parents).toEqual([await repo.resolve('main~1'), await repo.resolve('bob/edits')]);
    const text = renderDoc((await repo.readDoc('main', 'paper.md'))!);
    expect(text).toContain('64 participants');
    expect(text).toContain('negative words');
    expect(await repo.readDoc('main', 'notes.md')).toBeDefined();
  });

  it('returns a draft on conflict and completes it with resolutions', async () => {
    const { repo } = await diverged(
      paper.replace('Recall improved by 20%.', 'Recall improved by 25%.'),
      paper.replace('Recall improved by 20%.', 'Recall improved by 30%.'),
    );
    const out = await repo.merge({ into: 'main', from: 'bob/edits', author: alice });
    if (out.status !== 'conflicts') throw new Error(`expected conflicts, got ${out.status}`);
    expect(Object.keys(out.draft.conflicts)).toEqual(['paper.md']);
    expect(Object.keys(out.draft.tree)).toEqual(['notes.md']);

    // The draft is plain data: it can go to a UI and come back.
    const draft = JSON.parse(JSON.stringify(out.draft));
    await expect(repo.completeMerge(draft, {}, alice)).rejects.toThrow(UnresolvedConflictsError);

    const head = await repo.completeMerge(draft, { 'paper.md': { c1: 'theirs' } }, alice, 'Merge Bob, keep 30%');
    expect(await repo.resolve('main')).toBe(head);
    expect(renderDoc((await repo.readDoc('main', 'paper.md'))!)).toContain('30%');
    expect((await repo.readCommit(head)).message).toBe('Merge Bob, keep 30%');
    // Merged history now contains Bob's branch.
    expect(await repo.merge({ into: 'main', from: 'bob/edits', author: alice })).toMatchObject({ status: 'up-to-date' });
  });

  it('accepts a hand-written resolution', async () => {
    const { repo } = await diverged(
      paper.replace('Recall improved by 20%.', 'Recall improved by 25%.'),
      paper.replace('Recall improved by 20%.', 'Recall improved by 30%.'),
    );
    const out = await repo.merge({ into: 'main', from: 'bob/edits', author: alice });
    if (out.status !== 'conflicts') throw new Error();
    const region = out.draft.conflicts['paper.md']!.regions.find((r) => r.type === 'conflict')!;
    if (region.type !== 'conflict') throw new Error();
    const manual = [{ ...region.ours[0]!, text: region.ours[0]!.text.replace('25%', '25–30%') }];
    await repo.completeMerge(out.draft, { 'paper.md': { c1: { units: manual } } }, alice);
    expect(renderDoc((await repo.readDoc('main', 'paper.md'))!)).toContain('25–30%');
  });

  it('refuses to complete a merge if the target branch moved meanwhile', async () => {
    const { repo } = await diverged(
      paper.replace('Recall improved by 20%.', 'Recall improved by 25%.'),
      paper.replace('Recall improved by 20%.', 'Recall improved by 30%.'),
    );
    const out = await repo.merge({ into: 'main', from: 'bob/edits', author: alice });
    if (out.status !== 'conflicts') throw new Error();
    await repo.commit({ branch: 'main', author: alice, message: 'meanwhile', changes: { 'late.md': md('Late') } });
    await expect(repo.completeMerge(out.draft, { 'paper.md': { c1: 'ours' } }, alice)).rejects.toThrow(RefConflictError);
  });

  it('merges file additions and deletions across branches', async () => {
    const { repo } = await makeRepo();
    await repo.commit({ branch: 'main', author: alice, message: 'base', changes: { 'a.md': md('A'), 'b.md': md('B') } });
    await repo.createBranch('x', 'main');
    await repo.commit({ branch: 'main', author: alice, message: 'rm a', changes: { 'a.md': null, 'c.md': md('C') } });
    await repo.commit({ branch: 'x', author: bob, message: 'add d', changes: { 'd.md': md('D') } });
    const out = await repo.merge({ into: 'main', from: 'x', author: alice });
    expect(out.status).toBe('merged');
    expect(Object.keys(await repo.getTree('main'))).toEqual(['b.md', 'c.md', 'd.md']);
  });

  it('diffs across branches', async () => {
    const { repo } = await diverged(paper.replace('40', '41'), paper.replace('eight hours', 'nine hours'));
    const d = await repo.diff('main', 'bob/edits');
    expect(d.files).toHaveLength(1);
    expect(d.files[0]!.diff.stats.modified).toBe(2);
  });
});
