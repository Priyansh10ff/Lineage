import { describe, expect, it } from 'vitest';
import { applyResolution, mergeDocs, mergeText, renderDoc } from '../src/index.js';
import { chat, md, paper } from './helpers.js';

describe('mergeText (sentence level)', () => {
  it('merges edits to different sentences', () => {
    const base = 'Alpha one. Beta two. Gamma three.';
    expect(mergeText(base, 'Alpha ONE. Beta two. Gamma three.', 'Alpha one. Beta two. Gamma THREE.')).toBe(
      'Alpha ONE. Beta two. Gamma THREE.',
    );
  });

  it('refuses when both sides change the same sentence', () => {
    expect(mergeText('A b c. D e f.', 'A b X. D e f.', 'A b Y. D e f.')).toBeNull();
  });

  it('accepts identical changes on both sides', () => {
    expect(mergeText('A. B.', 'A. B2.', 'A. B2.')).toBe('A. B2.');
  });
});

describe('mergeDocs', () => {
  const base = md(paper);

  it('merges edits to different paragraphs cleanly', () => {
    const ours = md(paper.replace('40 participants', '64 participants'));
    const theirs = md(paper.replace('strongest for emotional words', 'strongest for negative words'));
    const r = mergeDocs(base, ours, theirs);
    expect(r.status).toBe('clean');
    if (r.status !== 'clean') throw new Error();
    const text = renderDoc(r.doc!);
    expect(text).toContain('64 participants');
    expect(text).toContain('negative words');
  });

  it('merges edits to different sentences of the same paragraph', () => {
    const ours = md(paper.replace('Participants slept for eight hours.', 'Participants slept for seven hours.'));
    const theirs = md(paper.replace('Recall improved by 20%.', 'Recall improved by 23%.'));
    const r = mergeDocs(base, ours, theirs);
    expect(r.status).toBe('clean');
    if (r.status !== 'clean') throw new Error();
    expect(r.autoResolved).toBe(1);
    expect(renderDoc(r.doc!)).toContain('Participants slept for seven hours. Recall improved by 23%.');
  });

  it('merges edits to adjacent paragraphs', () => {
    const b = md('P1 original text here.\n\nP2 original text here.\n\nP3 stays.');
    const o = md('P1 changed by us.\n\nP2 original text here.\n\nP3 stays.');
    const t = md('P1 original text here.\n\nP2 changed by them.\n\nP3 stays.');
    const r = mergeDocs(b, o, t);
    expect(r.status).toBe('clean');
    if (r.status !== 'clean') throw new Error();
    expect(r.doc!.units.map((u) => u.text)).toEqual(['P1 changed by us.', 'P2 changed by them.', 'P3 stays.']);
  });

  it('surfaces a conflict when both sides change the same sentence', () => {
    const ours = md(paper.replace('Recall improved by 20%.', 'Recall improved by 25%.'));
    const theirs = md(paper.replace('Recall improved by 20%.', 'Recall improved by 30%.'));
    const r = mergeDocs(base, ours, theirs);
    expect(r.status).toBe('conflict');
    if (r.status !== 'conflict') throw new Error();
    expect(r.reason).toBe('content');
    const conflicts = r.regions.filter((x) => x.type === 'conflict');
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0]!;
    if (c.type !== 'conflict') throw new Error();
    expect(c.id).toBe('c1');
    expect(c.ours[0]!.text).toContain('25%');
    expect(c.theirs[0]!.text).toContain('30%');
    expect(c.base[0]!.text).toContain('20%');

    const resolved = applyResolution(r, { c1: 'theirs' });
    expect(resolved.missing).toEqual([]);
    expect(renderDoc(resolved.doc!)).toContain('30%');
    expect(applyResolution(r, {}).missing).toEqual(['c1']);
  });

  it('supports keeping both sides when both inserted at the same spot', () => {
    const b = md('Intro.\n\nOutro.');
    const o = md('Intro.\n\nOur new paragraph.\n\nOutro.');
    const t = md('Intro.\n\nTheir new paragraph.\n\nOutro.');
    const r = mergeDocs(b, o, t);
    if (r.status !== 'conflict') throw new Error('expected conflict');
    const out = applyResolution(r, { c1: 'ours-then-theirs' });
    expect(out.doc!.units.map((u) => u.text)).toEqual(['Intro.', 'Our new paragraph.', 'Their new paragraph.', 'Outro.']);
  });

  it('handles delete vs modify', () => {
    const edited = md(paper.replace('40', '50'));
    const r = mergeDocs(base, null, edited);
    if (r.status !== 'conflict') throw new Error('expected conflict');
    expect(r.reason).toBe('delete-modify');
    expect(r.deletedBy).toBe('ours');
    expect(applyResolution(r, { c1: 'ours' }).doc).toBeNull();
    expect(renderDoc(applyResolution(r, { c1: 'theirs' }).doc!)).toContain('50 participants');
  });

  it('deletes cleanly when the other side left the file alone', () => {
    expect(mergeDocs(base, null, base)).toEqual({ status: 'clean', doc: null, autoResolved: 0 });
  });

  it('flags add/add with different content', () => {
    const r = mergeDocs(null, md('Mine.'), md('Yours.'));
    expect(r.status === 'conflict' && r.reason).toBe('add-add');
    expect(mergeDocs(null, md('Same.'), md('Same.')).status).toBe('clean');
  });

  it('merges chat branches that continued differently as a conflict at the tail', () => {
    const b = chat(['user', 'Q1'], ['assistant', 'A1']);
    const o = chat(['user', 'Q1'], ['assistant', 'A1'], ['user', 'Follow-up from us']);
    const t = chat(['user', 'Q1'], ['assistant', 'A1'], ['user', 'Follow-up from them']);
    const r = mergeDocs(b, o, t);
    expect(r.status).toBe('conflict');
  });
});
