import { describe, expect, it } from 'vitest';
import { ingest, parsePdf } from '../src/index.js';
import { makePaper } from './pdf-fixture.js';

describe('PDF ingestion', () => {
  it('rebuilds headings and paragraphs from layout', async () => {
    const { doc, pages, empty } = await parsePdf(await makePaper());
    expect(pages).toBe(2);
    expect(empty).toBe(false);
    expect(doc.kind).toBe('pdf');
    expect(doc.title).toBe('Sleep and Memory Consolidation');
    expect(doc.units.map((u) => [u.type, u.meta?.['page'], u.text])).toEqual([
      ['heading', 1, 'Sleep and Memory Consolidation'],
      ['heading', 1, 'Abstract'],
      [
        'paragraph',
        1,
        'We study how sleep affects memory consolidation in adults. Participants slept for eight hours before a recall test. Recall improved by twenty percent.',
      ],
      ['heading', 1, '1. Introduction'],
      // "sam-\nples" is de-hyphenated.
      ['paragraph', 1, 'Memory consolidation is thought to depend on sleep. Prior work used small samples and short retention intervals.'],
      // Extra vertical space starts a new paragraph; the paragraph continues across the page break.
      [
        'paragraph',
        1,
        'We address both limitations with a larger cohort and a longer delay between learning and testing, which lets us separate consolidation from simple rehearsal effects observed in earlier experiments.',
      ],
      ['heading', 2, '2. Methods'],
      ['paragraph', 2, 'We recruited forty participants from a university campus.'],
    ]);
    // Running header and page numbers are gone.
    expect(doc.units.some((u) => u.text.includes('Journal of Reproducible Tests'))).toBe(false);
  });

  it('prefers the title from PDF metadata', async () => {
    const { doc } = await parsePdf(await makePaper({ title: 'Official Title' }));
    expect(doc.title).toBe('Official Title');
  });

  it('groups bullet lists', async () => {
    const pdf = await makePaper({
      furniture: false,
      pages: [
        [
          { text: 'We compare three retrievers:', gap: 0 },
          { text: '• BM25 with default parameters' },
          { text: '• A dense retriever trained on', gap: 14 },
          { text: 'scientific abstracts' },
          { text: '• Hybrid reciprocal rank fusion' },
        ],
      ],
    });
    const { doc } = await parsePdf(pdf);
    expect(doc.units.map((u) => [u.type, u.text])).toEqual([
      ['paragraph', 'We compare three retrievers:'],
      ['list', '• BM25 with default parameters\n• A dense retriever trained on scientific abstracts\n• Hybrid reciprocal rank fusion'],
    ]);
  });

  it('warns on PDFs with no text layer', async () => {
    const r = await ingest({ name: 'scan.pdf', data: await makePaper({ pages: [[]], furniture: false }) });
    expect(r.artifacts[0]!.path).toBe('papers/scan.pdf');
    expect(r.warnings[0]).toMatch(/no extractable text/);
  });

  it('reports corrupt PDFs instead of throwing', async () => {
    const r = await ingest({ name: 'broken.pdf', data: new TextEncoder().encode('%PDF-1.7 garbage') });
    expect(r.artifacts).toEqual([]);
    expect(r.warnings[0]).toMatch(/could not read PDF/);
  });
});
