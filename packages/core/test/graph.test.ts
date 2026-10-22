import { describe, expect, it } from 'vitest';
import { alice, bob, makeRepo, md } from './helpers.js';

describe('transit map layout', () => {
  it('puts main on row 0, branches on their own rows, and recovers deleted branches', async () => {
    const { repo } = await makeRepo();
    await repo.commit({ branch: 'main', author: alice, message: 'base', changes: { 'a.md': md('A') } });
    await repo.createBranch('lit', 'main');
    await repo.commit({ branch: 'lit', author: alice, message: 'lit 1', changes: { 'b.md': md('B') } });
    await repo.commit({ branch: 'main', author: bob, message: 'main 2', changes: { 'c.md': md('C') } });
    await repo.merge({ into: 'main', from: 'lit', author: alice, message: 'Merge lit into main' });
    await repo.deleteBranch('lit');
    await repo.commit({ branch: 'main', author: bob, message: 'main 3', changes: { 'e.md': md('E') } });
    await repo.createBranch('agent/x', 'main');
    await repo.commit({ branch: 'agent/x', author: bob, message: 'agent 1', changes: { 'd.md': md('D') } });

    const g = await repo.graph();
    const byMsg = (m: string) => g.nodes.find((n) => n.commit.message === m)!;
    expect(byMsg('base').row).toBe(0);
    expect(byMsg('main 2').row).toBe(0);
    expect(byMsg('lit 1').row).toBe(1);
    // agent/x starts after lit merged, so it reuses row 1.
    expect(byMsg('agent 1').row).toBe(1);
    expect(byMsg('main 3').heads).toEqual(['main']);

    const lanes = Object.fromEntries(g.lanes.map((l) => [l.name, l.status]));
    expect(lanes).toEqual({ main: 'primary', 'agent/x': 'active', lit: 'merged' });
    expect(g.edges.filter((e) => e.kind === 'merge')).toHaveLength(1);
    expect(g.edges.filter((e) => e.kind === 'branch')).toHaveLength(2);
    // Parents always come before children.
    for (const e of g.edges) {
      expect(g.nodes.find((n) => n.hash === e.from)!.column).toBeLessThan(g.nodes.find((n) => n.hash === e.to)!.column);
    }
  });

  it('keeps overlapping branches on separate rows', async () => {
    const { repo } = await makeRepo();
    await repo.createBranch('a', 'main');
    await repo.createBranch('b', 'main');
    await repo.commit({ branch: 'a', author: alice, message: 'a1', changes: { 'a.md': md('A') } });
    await repo.commit({ branch: 'b', author: bob, message: 'b1', changes: { 'b.md': md('B') } });
    const g = await repo.graph();
    const rows = new Set(g.nodes.filter((n) => n.commit.message !== 'Initialize workspace').map((n) => n.row));
    expect(rows.size).toBe(2);
    expect(g.rows).toBe(3);
  });

  it('previews a merge without moving refs', async () => {
    const { repo } = await makeRepo();
    await repo.commit({ branch: 'main', author: alice, message: 'base', changes: { 'p.md': md('One. Two.') } });
    await repo.createBranch('x', 'main');
    await repo.commit({ branch: 'x', author: bob, message: 'x', changes: { 'p.md': md('One. Three.') } });
    await repo.commit({ branch: 'main', author: alice, message: 'm', changes: { 'q.md': md('Q') } });
    const head = await repo.resolve('main');
    const p = await repo.previewMerge({ into: 'main', from: 'x' });
    expect(p.status).toBe('ready');
    if (p.status !== 'ready') throw new Error();
    expect(p.canFastForward).toBe(false);
    expect(await repo.resolve('main')).toBe(head);
    const merged = await repo.completeMerge(p.draft, {}, alice);
    expect((await repo.readCommit(merged)).parents).toHaveLength(2);
  });
});
