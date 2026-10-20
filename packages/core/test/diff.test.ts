import { describe, expect, it } from 'vitest';
import { diffDocs, diffTreeEntries, type UnitChange } from '../src/index.js';
import { chat, md, paper } from './helpers.js';

const nonEqual = (cs: UnitChange[]) => cs.filter((c) => c.op !== 'equal');

describe('semantic diff', () => {
  it('reports no changes for identical docs', () => {
    const d = diffDocs(md(paper), md(paper));
    expect(d.stats).toMatchObject({ added: 0, removed: 0, modified: 0, moved: 0 });
    expect(d.summary).toEqual(['No content changes']);
  });

  it('ignores reflowed whitespace', () => {
    const reflowed = paper.replace('We recruited 40 participants from', 'We recruited 40 participants\nfrom');
    expect(diffDocs(md(paper), md(reflowed)).stats.modified).toBe(0);
  });

  it('shows an edited paragraph as modified, down to the sentence and word', () => {
    const after = paper.replace('We recruited 40 participants', 'We recruited 64 participants');
    const d = diffDocs(md(paper), md(after));
    const [c] = nonEqual(d.changes);
    expect(c?.op).toBe('modified');
    if (c?.op !== 'modified') throw new Error();
    expect(c.section).toBe('Methods');
    const seg = c.segments.find((s) => s.op === 'modified');
    expect(seg?.op).toBe('modified');
    if (seg?.op !== 'modified') throw new Error();
    expect(seg.words.filter((w) => w.op !== 'equal').map((w) => [w.op, w.text])).toEqual([
      ['removed', '40'],
      ['added', '64'],
    ]);
    // The untouched second sentence stays equal.
    expect(c.segments.filter((s) => s.op === 'equal')).toHaveLength(1);
    expect(d.summary).toEqual(['Edited paragraph in "Methods" (1 sentence changed)']);
  });

  it('detects added sentences inside a paragraph', () => {
    const after = paper.replace(
      'Each completed a word-pair task before sleeping.',
      'Each completed a word-pair task before sleeping. Sessions were held at 9pm.',
    );
    const [c] = nonEqual(diffDocs(md(paper), md(after)).changes);
    if (c?.op !== 'modified') throw new Error(`expected modified, got ${c?.op}`);
    expect(c.segments.filter((s) => s.op === 'added').map((s) => s.op === 'added' && s.text)).toEqual([
      'Sessions were held at 9pm.',
    ]);
  });

  it('detects moved paragraphs instead of delete + insert', () => {
    const before = md('# T\n\nAlpha paragraph about apples.\n\nBeta paragraph about bananas.\n\nGamma paragraph about grapes.');
    const after = md('# T\n\nBeta paragraph about bananas.\n\nGamma paragraph about grapes.\n\nAlpha paragraph about apples.');
    const d = diffDocs(before, after);
    expect(d.stats).toMatchObject({ moved: 1, added: 0, removed: 0 });
    expect(d.summary[0]).toMatch(/^Moved paragraph "Alpha paragraph about apples\." from position 2 to 4$/);
  });

  it('detects a paragraph that was moved and edited', () => {
    const before = md(
      'Intro text that stays.\n\nThe sample consisted of forty adults recruited online.\n\nMiddle text.\n\nOutro text.',
    );
    const after = md(
      'Intro text that stays.\n\nMiddle text.\n\nOutro text.\n\nThe sample consisted of forty-two adults recruited online.',
    );
    const d = diffDocs(before, after);
    const moved = d.changes.find((c) => c.op === 'moved');
    expect(moved?.op).toBe('moved');
    if (moved?.op !== 'moved') throw new Error();
    expect(moved.similarity).toBeLessThan(1);
    expect(d.stats).toMatchObject({ added: 0, removed: 0 });
  });

  it('separates rewritten from unrelated replacements', () => {
    const before = md('Keep.\n\nThe experiment used a within-subjects design with two sessions.');
    const after = md('Keep.\n\nFunding was provided by a national science grant.');
    const d = diffDocs(before, after);
    expect(d.stats).toMatchObject({ added: 1, removed: 1, modified: 0 });
  });

  it('diffs chats turn by turn and never pairs different roles', () => {
    const before = chat(['user', 'What is RAG?'], ['assistant', 'RAG means retrieval augmented generation.']);
    const after = chat(
      ['user', 'What is RAG?'],
      ['assistant', 'RAG means retrieval augmented generation. It grounds answers in documents.'],
      ['user', 'Give an example.'],
    );
    const d = diffDocs(before, after);
    expect(nonEqual(d.changes).map((c) => c.op)).toEqual(['modified', 'added']);
    expect(d.summary).toEqual(['Edited assistant turn (1 added)', 'Added user turn: "Give an example."']);

    const swapped = chat(['assistant', 'What is RAG?']);
    expect(diffDocs(chat(['user', 'What is RAG?']), swapped).stats).toMatchObject({ modified: 0, added: 1, removed: 1 });
  });

  it('handles creation and deletion', () => {
    expect(diffDocs(null, md(paper)).stats.added).toBe(md(paper).units.length);
    expect(diffDocs(md(paper), null).stats.removed).toBe(md(paper).units.length);
  });

  it('diffs code blocks line by line', () => {
    const before = md('```py\ndef f(x):\n    return x + 1\n```');
    const after = md('```py\ndef f(x):\n    return x + 2\n```');
    const [c] = nonEqual(diffDocs(before, after).changes);
    if (c?.op !== 'modified') throw new Error();
    expect(c.segments.filter((s) => s.op === 'modified')).toHaveLength(1);
  });
});

describe('tree diff', () => {
  it('classifies files and detects renames', () => {
    const changes = diffTreeEntries({ 'a.md': 'h1', 'b.md': 'h2', 'c.md': 'h3' }, { 'a.md': 'h1', 'b.md': 'h9', 'd.md': 'h3', 'e.md': 'h4' });
    expect(changes).toEqual([
      { path: 'b.md', status: 'modified', oldHash: 'h2', newHash: 'h9' },
      { path: 'd.md', status: 'renamed', oldPath: 'c.md', oldHash: 'h3', newHash: 'h3' },
      { path: 'e.md', status: 'added', newHash: 'h4' },
    ]);
  });
});
