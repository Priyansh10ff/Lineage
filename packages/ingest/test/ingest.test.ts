import { MemoryStore, Repository } from '@lineage/core';
import { describe, expect, it } from 'vitest';
import { detectFormat, ingest } from '../src/index.js';
import { makePaper } from './pdf-fixture.js';

describe('format detection', () => {
  it('uses magic bytes, extensions and content', async () => {
    expect(detectFormat({ name: 'paper.bin', data: await makePaper() })).toBe('pdf');
    expect(detectFormat({ name: 'notes.md', data: '# Notes\n\nText.' })).toBe('markdown');
    expect(detectFormat({ name: 'notes.txt', data: 'Plain text.' })).toBe('text');
    expect(detectFormat({ name: 'chat.md', data: '**User:** hi\n\n**Assistant:** hello' })).toBe('chat-markdown');
    expect(detectFormat({ name: 'conversations.json', data: '[{"mapping": {}}]' })).toBe('chat-export');
    expect(detectFormat({ name: 'config.json', data: '{"a": 1}' })).toBe('code');
    expect(detectFormat({ name: 'main.rs', data: 'fn main() {}' })).toBe('code');
    expect(detectFormat({ name: 'photo.jpg', data: new Uint8Array([0xff, 0xd8, 0xff]) })).toBe('unknown');
  });
});

describe('markdown and text', () => {
  it('normalizes into a prose doc with a title', async () => {
    const { artifacts } = await ingest({ name: 'Lit Review.md', data: '# Literature review\n\nFirst paragraph.\n\n- a\n- b' });
    expect(artifacts[0]!.path).toBe('docs/Lit Review.md');
    expect(artifacts[0]!.doc).toMatchObject({ kind: 'prose', title: 'Literature review', meta: { source: 'markdown' } });
    expect(artifacts[0]!.doc.units.map((u) => u.type)).toEqual(['heading', 'paragraph', 'list']);
  });

  it('falls back to the file name for untitled text and strips a BOM', async () => {
    const { artifacts } = await ingest({ name: 'scratch.txt', data: new TextEncoder().encode('﻿Just some notes.') });
    expect(artifacts[0]!.doc.title).toBe('scratch');
    expect(artifacts[0]!.doc.units[0]!.text).toBe('Just some notes.');
  });

  it('applies a path prefix', async () => {
    const { artifacts } = await ingest({ name: 'a.md', data: 'A' }, { prefix: 'projects/sleep' });
    expect(artifacts[0]!.path).toBe('projects/sleep/docs/a.md');
  });

  it('rejects unknown files with a warning', async () => {
    const r = await ingest({ name: 'movie.mp4', data: new Uint8Array([0, 0, 0, 0x18]) });
    expect(r).toEqual({ artifacts: [], warnings: ['movie.mp4: unsupported file type'] });
  });
});

describe('end to end', () => {
  it('ingests mixed artifacts, commits them, and diffs a re-ingested PDF', async () => {
    const me = { id: 'u', name: 'Me' };
    const repo = await Repository.init(new MemoryStore(), { author: me });

    const v1 = await ingest({ name: 'paper.pdf', data: await makePaper() });
    const notes = await ingest({ name: 'notes.md', data: '# Notes\n\nCheck sample size.' });
    const changes = Object.fromEntries([...v1.artifacts, ...notes.artifacts].map((a) => [a.path, a.doc]));
    await repo.commit({ branch: 'main', author: me, message: 'Import paper and notes', changes });

    // A revised version of the PDF: one sentence changed on page 2.
    const v2 = await ingest({
      name: 'paper.pdf',
      data: await makePaper({
        pages: [
          (await import('./pdf-fixture.js')).DEFAULT_PAGES[0]!,
          [
            { text: 'simple rehearsal effects observed in earlier experiments.', gap: 0 },
            { text: '2. Methods', size: 13, gap: 30 },
            { text: 'We recruited sixty participants from two university campuses.', gap: 20 },
          ],
        ],
      }),
    });
    await repo.commit({
      branch: 'main',
      author: me,
      message: 'Revised paper',
      changes: { [v2.artifacts[0]!.path]: v2.artifacts[0]!.doc },
    });

    const diff = await repo.diff('main~1', 'main');
    expect(diff.files.map((f) => f.path)).toEqual(['papers/paper.pdf']);
    expect(diff.files[0]!.diff.summary).toEqual(['Edited paragraph in "2. Methods, p.2" (1 sentence changed)']);
  });
});
