import { parseProse } from '@lineage/core';
import { unzipSync } from 'fflate';
import { looksLikeChatMarkdown, parseChatExport, parseChatMarkdown } from './chat.js';
import { isCodePath, parseCode } from './code.js';
import { parsePdf } from './pdf.js';
import type { IngestInput, IngestOptions, IngestResult, IngestedArtifact, SourceFormat } from './types.js';
import { basename, cleanPath, extname, isBinary, joinPath, slugify, stripExt, toBytes, toText } from './util.js';

const PROSE_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.txt', '.text', '.rst', '.org', '']);

/** Directories and files that never belong in a research workspace. */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache', 'target',
  'vendor', '__pycache__', '.venv', 'venv', 'env', '.mypy_cache', '.pytest_cache', 'coverage', '.idea', '.vscode',
  '__MACOSX',
]);
const IGNORED_FILES =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|go\.sum|composer\.lock|\.DS_Store|Thumbs\.db)$|\.min\.(js|css)$|\.map$/;

export function isIgnoredPath(path: string): boolean {
  const parts = cleanPath(path).split('/');
  return parts.slice(0, -1).some((p) => IGNORED_DIRS.has(p)) || IGNORED_FILES.test(path);
}

export type DetectedFormat = SourceFormat | 'zip' | 'chat-export' | 'unknown';

/** Guess what a file is from its name and first bytes. JSON exports are confirmed by shape when parsed. */
export function detectFormat(input: IngestInput): DetectedFormat {
  const ext = extname(input.name);
  const bytes = typeof input.data === 'string' ? null : input.data;
  if (bytes && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf'; // %PDF
  if (bytes && bytes[0] === 0x50 && bytes[1] === 0x4b) return 'zip'; // PK
  if (ext === '.pdf') return 'pdf';
  if (ext === '.zip') return 'zip';
  if (ext === '.json') {
    const head = toText(typeof input.data === 'string' ? input.data.slice(0, 4096) : input.data.subarray(0, 4096));
    if (/"mapping"\s*:|"chat_messages"\s*:/.test(head)) return 'chat-export';
  }
  if (PROSE_EXTENSIONS.has(ext)) {
    if (bytes && isBinary(bytes)) return 'unknown';
    const text = toText(input.data);
    if (ext !== '.txt' && looksLikeChatMarkdown(text)) return 'chat-markdown';
    return ext === '.txt' || ext === '.text' ? 'text' : 'markdown';
  }
  if (isCodePath(input.name)) return 'code';
  return 'unknown';
}

function artifact(path: string, format: SourceFormat, sourceName: string, doc: IngestedArtifact['doc']): IngestedArtifact {
  return { path: cleanPath(path), doc, format, sourceName };
}

/**
 * Normalize one uploaded file into one or more artifacts:
 * - Markdown / text → prose doc
 * - ChatGPT or Claude `conversations.json` → one chat doc per conversation
 * - Markdown chat transcripts → chat doc
 * - PDF → paragraphs tagged with their page
 * - Source files → symbol units (tree-sitter when a code parser is given)
 * - Zip → each file inside, as above (a ChatGPT/Claude export zip yields its chats)
 */
export async function ingest(input: IngestInput, opts: IngestOptions = {}): Promise<IngestResult> {
  const prefix = opts.prefix;
  const name = basename(input.name);
  const format = detectFormat(input);
  const warnings: string[] = [];
  const artifacts: IngestedArtifact[] = [];

  switch (format) {
    case 'markdown':
    case 'text': {
      const doc = parseProse(toText(input.data));
      doc.title ??= stripExt(name);
      doc.meta = { source: format };
      artifacts.push(artifact(joinPath(prefix, 'docs', name), format, input.name, doc));
      break;
    }
    case 'chat-markdown': {
      const doc = parseChatMarkdown(toText(input.data), stripExt(name));
      artifacts.push(artifact(joinPath(prefix, 'chats', 'markdown', `${slugify(stripExt(name))}.chat`), format, input.name, doc));
      break;
    }
    case 'chat-export': {
      let json: unknown;
      try {
        json = JSON.parse(toText(input.data));
      } catch (e) {
        warnings.push(`${input.name}: invalid JSON (${(e as Error).message})`);
        break;
      }
      const parsed = parseChatExport(json);
      if (!parsed) {
        warnings.push(`${input.name}: not a ChatGPT or Claude conversation export`);
        break;
      }
      const used = new Set<string>();
      for (const chat of parsed.chats) {
        let slug = `${slugify(chat.doc.title ?? 'untitled')}-${slugify(chat.id).replace(/-/g, '').slice(0, 8)}`;
        while (used.has(slug)) slug += '-x';
        used.add(slug);
        artifacts.push(artifact(joinPath(prefix, 'chats', parsed.format, `${slug}.chat`), parsed.format, input.name, chat.doc));
      }
      if (!parsed.chats.length) warnings.push(`${input.name}: export contained no conversations with visible messages`);
      break;
    }
    case 'pdf': {
      try {
        const { doc, empty } = await parsePdf(toBytes(input.data), stripExt(name));
        if (empty) warnings.push(`${input.name}: no extractable text (scanned PDF? OCR is not supported)`);
        artifacts.push(artifact(joinPath(prefix, 'papers', name), 'pdf', input.name, doc));
      } catch (e) {
        warnings.push(`${input.name}: could not read PDF (${(e as Error).message})`);
      }
      break;
    }
    case 'code': {
      const bytes = toBytes(input.data);
      if (isBinary(bytes)) {
        warnings.push(`${input.name}: binary file skipped`);
        break;
      }
      const path = cleanPath(input.name);
      const doc = await parseCode(path, toText(bytes), opts.codeParser);
      artifacts.push(artifact(joinPath(prefix, 'code', path), 'code', input.name, doc));
      break;
    }
    case 'zip':
      return ingestZip(input, opts);
    default:
      warnings.push(`${input.name}: unsupported file type`);
  }
  return { artifacts, warnings };
}

/**
 * Ingest a zip: either a ChatGPT/Claude data export (detected by a `conversations.json`)
 * or a codebase / folder of research files, keeping relative paths.
 */
export async function ingestZip(input: IngestInput, opts: IngestOptions = {}): Promise<IngestResult> {
  const maxBytes = opts.maxFileBytes ?? 1_000_000;
  const warnings: string[] = [];
  const artifacts: IngestedArtifact[] = [];
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(toBytes(input.data), {
      filter: (f) => !f.name.endsWith('/') && !isIgnoredPath(f.name) && f.originalSize <= maxBytes * 50,
    });
  } catch (e) {
    return { artifacts, warnings: [`${input.name}: could not unzip (${(e as Error).message})`] };
  }

  const paths = Object.keys(files).sort();
  // Strip a single shared top-level folder (GitHub "Download ZIP" wraps everything in repo-main/).
  const tops = new Set(paths.map((p) => p.split('/')[0]));
  const strip = tops.size === 1 && paths.every((p) => p.includes('/')) ? `${[...tops][0]}/` : '';
  const root = slugify(stripExt(input.name));

  const conversations = paths.find((p) => basename(p) === 'conversations.json');
  if (conversations) {
    // A ChatGPT/Claude data export: only the conversations matter.
    const r = await ingest({ name: conversations, data: files[conversations]! }, opts);
    return { artifacts: r.artifacts, warnings: [...warnings, ...r.warnings] };
  }

  for (const p of paths) {
    const data = files[p]!;
    const rel = p.slice(strip.length);
    if (data.length > maxBytes) {
      warnings.push(`${rel}: skipped (${Math.round(data.length / 1024)} KB exceeds limit)`);
      continue;
    }
    const fmt = detectFormat({ name: rel, data });
    if (fmt === 'unknown' || fmt === 'zip') continue; // images, binaries, nested archives
    const inner = await ingest({ name: rel, data }, { ...opts, prefix: undefined });
    for (const a of inner.artifacts) {
      // Keep the archive's folder structure under <archive-name>/. Chat exports keep their chats/ path.
      const isChat = a.format === 'chatgpt' || a.format === 'claude';
      const path = isChat ? joinPath(opts.prefix, a.path) : joinPath(opts.prefix, root, rel);
      artifacts.push({ ...a, path, sourceName: `${input.name}/${rel}` });
    }
    warnings.push(...inner.warnings);
  }
  return { artifacts, warnings };
}
