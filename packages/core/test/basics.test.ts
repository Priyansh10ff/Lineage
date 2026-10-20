import { describe, expect, it } from 'vitest';
import { canonicalize, hashObject, parseProse, renderDoc, similarity, splitSentences } from '../src/index.js';
import { paper } from './helpers.js';

describe('hashing', () => {
  it('is independent of key order and drops undefined', () => {
    expect(canonicalize({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe('{"a":[1,{"d":2}],"b":1}');
  });

  it('gives equal content equal addresses and separates types', () => {
    const doc = { kind: 'prose' as const, units: [{ type: 'paragraph' as const, text: 'x' }] };
    expect(hashObject({ type: 'blob', doc })).toBe(hashObject({ type: 'blob', doc: { units: doc.units, kind: 'prose' } }));
    expect(hashObject({ type: 'tree', entries: {} })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('prose parsing', () => {
  it('splits markdown into block units', () => {
    const doc = parseProse(
      '# Title\n\nPara one\ncontinues.\n\n- a\n- b\n  nested\n\n> quote\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\n\nEnd.',
    );
    expect(doc.title).toBe('Title');
    expect(doc.units.map((u) => u.type)).toEqual(['heading', 'paragraph', 'list', 'quote', 'code_block', 'paragraph']);
    expect(doc.units[2]!.text).toBe('- a\n- b\n  nested');
    expect(doc.units[4]!.text).toContain('const y = 2;');
  });

  it('round-trips through render', () => {
    const doc = parseProse(paper);
    expect(parseProse(renderDoc(doc))).toEqual(doc);
  });
});

describe('text utilities', () => {
  it('splits sentences and keeps whitespace', () => {
    const s = splitSentences('One thing. Two things! Three?');
    expect(s).toEqual(['One thing. ', 'Two things! ', 'Three?']);
    expect(s.join('')).toBe('One thing. Two things! Three?');
  });

  it('scores similarity', () => {
    expect(similarity('the cat sat on the mat', 'the cat sat on the mat')).toBe(1);
    expect(similarity('the cat sat on the mat', 'the cat sat on a rug')).toBeGreaterThan(0.5);
    expect(similarity('the cat sat on the mat', 'quantum chromodynamics lattice results')).toBeLessThan(0.2);
  });
});
