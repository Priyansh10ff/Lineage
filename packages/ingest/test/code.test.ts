import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, Repository, renderDoc } from '@lineage/core';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { chunkByBlocks, ingest } from '../src/index.js';
import { createNodeCodeParser, ingestDirectory } from '../src/node.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const parser = createNodeCodeParser();
const symbols = (doc: { units: { type: string; meta?: Record<string, unknown> }[] }) =>
  doc.units.map((u) => (u.type === 'symbol' ? `${u.meta?.['symbolKind']}:${u.meta?.['name']}` : u.type));

describe('code parsing (tree-sitter)', () => {
  it('splits TypeScript into symbols and class members', async () => {
    const source = fixture('greeter.ts');
    const doc = (await parser.parse('src/greeter.ts', source))!;
    expect(doc.meta).toMatchObject({ language: 'typescript', parser: 'tree-sitter' });
    expect(symbols(doc)).toEqual([
      'imports:imports',
      'variable:DEFAULT_GREETING',
      'interface:Person',
      'class:Greeter',
      'variable:Greeter.count',
      'method:Greeter.constructor',
      'method:Greeter.greet',
      'method:Greeter.greeted',
      'function:loadPeople',
      'function:shout',
    ]);
    // Leading comments stay with their declaration.
    expect(doc.units[6]!.text.startsWith('  /** Greet one person. */')).toBe(true);
    // Units are contiguous: the file round-trips byte for byte.
    expect(renderDoc(doc)).toBe(source);
  });

  it('handles Python decorators, functions and script blocks', async () => {
    const source = fixture('analysis.py');
    const doc = (await parser.parse('analysis.py', source))!;
    expect(symbols(doc)).toEqual(['imports:imports', 'class:Result', 'function:summarize', 'line']);
    expect(doc.units[1]!.text.startsWith('@dataclass')).toBe(true);
    expect(renderDoc(doc)).toBe(source);
  });

  it('round-trips non-ASCII source exactly', async () => {
    const source = '// héllo ✓ 😀\nexport const s = "é";\n\nexport function f() {\n  return "ü";\n}\n';
    const doc = (await parser.parse('x.ts', source))!;
    expect(renderDoc(doc)).toBe(source);
    expect(symbols(doc)).toEqual(['variable:s', 'function:f']);
  });

  it('returns null for languages without a grammar, and chunking covers them', async () => {
    expect(await parser.parse('build.kt', 'fun main() {}')).toBeNull();
    const source = 'a = 1\nb = 2\n\n\nc = 3\n';
    const doc = chunkByBlocks('x.toml', source);
    expect(doc.units.map((u) => u.text)).toEqual(['a = 1\nb = 2\n\n\n', 'c = 3\n']);
    expect(renderDoc(doc)).toBe(source);
  });
});

describe('semantic code diffs', () => {
  it('names the method that changed', async () => {
    const me = { id: 'u', name: 'Me' };
    const repo = await Repository.init(new MemoryStore(), { author: me });
    const before = fixture('greeter.ts');
    const after = before.replace('this.count++;', 'this.count += 1;').replace(
      "export const shout = (s: string) => s.toUpperCase();",
      "export const shout = (s: string) => s.toUpperCase();\n\nexport const whisper = (s: string) => s.toLowerCase();",
    );
    const put = async (src: string, msg: string) =>
      repo.commit({ branch: 'main', author: me, message: msg, changes: { 'greeter.ts': (await parser.parse('greeter.ts', src))! } });
    await put(before, 'v1');
    await put(after, 'v2');
    const diff = await repo.diff('main~1', 'main');
    expect(diff.files[0]!.diff.summary).toEqual([
      'Edited method `Greeter.greet` (1 line changed)',
      'Added function `whisper`: "export const whisper = (s: string) => s.toLowerCase();"',
    ]);
  });
});

describe('archives and directories', () => {
  it('ingests a GitHub-style zip, stripping the wrapper folder and skipping junk', async () => {
    const zip = zipSync({
      'lineage-main/README.md': strToU8('# Lineage\n\nGit for research.'),
      'lineage-main/src/greeter.ts': strToU8(fixture('greeter.ts')),
      'lineage-main/src/analysis.py': strToU8(fixture('analysis.py')),
      'lineage-main/node_modules/x/index.js': strToU8('module.exports = 1;'),
      'lineage-main/package-lock.json': strToU8('{}'),
      'lineage-main/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
    });
    const { artifacts } = await ingest({ name: 'lineage-main.zip', data: zip }, { codeParser: parser });
    expect(artifacts.map((a) => [a.path, a.format])).toEqual([
      ['lineage-main/README.md', 'markdown'],
      ['lineage-main/src/analysis.py', 'code'],
      ['lineage-main/src/greeter.ts', 'code'],
    ]);
    expect(artifacts[2]!.doc.meta?.['parser']).toBe('tree-sitter');
  });

  it('treats a zip with conversations.json as a chat export', async () => {
    const zip = zipSync({
      'conversations.json': strToU8(fixture('claude-conversations.json')),
      'users.json': strToU8('[]'),
      'projects.json': strToU8('[]'),
    });
    const { artifacts } = await ingest({ name: 'claude-export.zip', data: zip });
    expect(artifacts.map((a) => a.path)).toEqual(['chats/claude/sleep-study-design-0a9b8c7d.chat']);
  });

  it('ingests a directory like a cloned repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lineage-'));
    const root = join(dir, 'study');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, '.git', 'config'), '[core]');
    writeFileSync(join(root, 'src', 'analysis.py'), fixture('analysis.py'));
    writeFileSync(join(root, 'notes', 'ideas.md'), '# Ideas\n\nTry hybrid retrieval.');
    writeFileSync(join(root, 'notes', 'chat.json'), fixture('chatgpt-conversations.json'));
    const { artifacts } = await ingestDirectory(root);
    expect(artifacts.map((a) => [a.path, a.format])).toEqual([
      ['chats/chatgpt/rag-chunking-strategies-6f1d2c3b.chat', 'chatgpt'],
      ['study/notes/ideas.md', 'markdown'],
      ['study/src/analysis.py', 'code'],
    ]);
  });
});
