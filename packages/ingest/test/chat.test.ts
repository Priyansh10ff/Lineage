import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectChatExport, ingest, looksLikeChatMarkdown, parseChatMarkdown } from '../src/index.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

describe('ChatGPT export', () => {
  it('rebuilds the visible thread from current_node and drops hidden content', async () => {
    const { artifacts, warnings } = await ingest({ name: 'conversations.json', data: fixture('chatgpt-conversations.json') });
    expect(warnings).toEqual([]);
    // The second conversation only has a system message, so it's skipped.
    expect(artifacts).toHaveLength(1);
    const [a] = artifacts;
    expect(a!.format).toBe('chatgpt');
    expect(a!.path).toBe('chats/chatgpt/rag-chunking-strategies-6f1d2c3b.chat');
    expect(a!.doc.kind).toBe('chat');
    expect(a!.doc.title).toBe('RAG chunking strategies');
    expect(a!.doc.meta).toMatchObject({ source: 'chatgpt', models: 'o3', createdAt: '2026-01-01T00:00:00.000Z' });

    const turns = a!.doc.units.map((u) => [u.meta?.['role'], u.text]);
    expect(turns).toEqual([
      // The edited user message (current branch), not the original one.
      ['user', '[image]\nHow big should chunks be for papers like this one?'],
      ['assistant', expect.stringContaining('chunk by section')],
      ['assistant', '```python\nprint(len(chunks))\n```'],
      ['tool', '42'],
      ['user', 'Thanks, that works.'],
    ]);
    // Reasoning ("thoughts") content is not part of the conversation.
    expect(a!.doc.units.some((u) => u.text.includes('hidden'))).toBe(false);
    // The edited message records that another version exists.
    expect(a!.doc.units[0]!.meta).toMatchObject({ alternates: 1 });
  });

  it('falls back to the last branch when current_node is missing', async () => {
    const json = JSON.parse(fixture('chatgpt-conversations.json').toString());
    delete json[0].current_node;
    const { artifacts } = await ingest({ name: 'c.json', data: JSON.stringify(json) });
    expect(artifacts[0]!.doc.units.at(-1)!.text).toBe('Thanks, that works.');
  });
});

describe('Claude export', () => {
  it('parses content blocks, skips thinking, and notes attachments', async () => {
    const { artifacts } = await ingest({ name: 'conversations.json', data: fixture('claude-conversations.json') });
    expect(artifacts).toHaveLength(1);
    const doc = artifacts[0]!.doc;
    expect(artifacts[0]!.path).toBe('chats/claude/sleep-study-design-0a9b8c7d.chat');
    expect(doc.units.map((u) => u.meta?.['role'])).toEqual(['user', 'assistant', 'user']);
    expect(doc.units[0]!.text).toBe('Review my methods section.\n\n[attachment: methods.md]');
    expect(doc.units[1]!.text).toBe(
      'Forty participants is small for a between-subjects design.\n\nConsider a power analysis.',
    );
    // Messages without content blocks fall back to `text`.
    expect(doc.units[2]!.text).toBe('What effect size should I assume?');
  });

  it('tells the two formats apart by shape', () => {
    expect(detectChatExport(JSON.parse(fixture('chatgpt-conversations.json').toString()))).toBe('chatgpt');
    expect(detectChatExport(JSON.parse(fixture('claude-conversations.json').toString()))).toBe('claude');
    expect(detectChatExport([{ foo: 1 }])).toBeNull();
  });

  it('reports invalid JSON instead of throwing', async () => {
    const r = await ingest({ name: 'conversations.json', data: '{"mapping": ' });
    expect(r.artifacts).toEqual([]);
    expect(r.warnings[0]).toMatch(/invalid JSON/);
  });
});

describe('Markdown transcripts', () => {
  it('detects and parses role markers', async () => {
    const { artifacts } = await ingest({ name: 'transcript.md', data: fixture('transcript.md') });
    expect(artifacts[0]!.format).toBe('chat-markdown');
    expect(artifacts[0]!.doc.title).toBe('Brainstorm with Claude');
    expect(artifacts[0]!.doc.units.map((u) => [u.meta?.['role'], u.text])).toEqual([
      ['user', 'What are good baselines for retrieval evaluation?'],
      ['assistant', 'Start with BM25. Then add a dense retriever.\n\nIt is also worth trying hybrid retrieval.'],
      ['user', 'Which metrics?'],
      ['assistant', 'Recall@k and nDCG@10.'],
    ]);
  });

  it('supports heading-style markers', () => {
    const doc = parseChatMarkdown('## You\n\nHi\n\n## ChatGPT said:\n\nHello!');
    expect(doc.units.map((u) => u.meta?.['role'])).toEqual(['user', 'assistant']);
  });

  it('does not mistake ordinary prose for a transcript', () => {
    expect(looksLikeChatMarkdown('# Notes\n\nUser research shows people want search.\n\nThe assistant role is unclear.')).toBe(false);
    expect(looksLikeChatMarkdown('**User:** only one side')).toBe(false);
  });
});
