/**
 * Node-only helpers: tree-sitter grammars loaded from disk, and ingestion of files and directories
 * (e.g. a cloned git repository).
 */
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { createTreeSitterParser, type TreeSitterModule } from './code.js';
import { detectFormat, ingest, isIgnoredPath } from './ingest.js';
import type { CodeParser, IngestOptions, IngestResult } from './types.js';
import { basename, joinPath } from './util.js';

const require = createRequire(import.meta.url);

let defaultParser: CodeParser | undefined;

/**
 * Where the grammar .wasm files live. Bundlers (Next.js/Turbopack) rewrite `require.resolve`
 * to module ids or virtual "[externals]" paths, so every candidate is checked on disk.
 */
function defaultWasmDir(): string {
  const candidates: string[] = [];
  if (process.env['LINEAGE_TREE_SITTER_WASM_DIR']) candidates.push(process.env['LINEAGE_TREE_SITTER_WASM_DIR']);
  try {
    const pkg: unknown = require.resolve('@vscode/tree-sitter-wasm/package.json');
    if (typeof pkg === 'string') candidates.push(join(dirname(pkg), 'wasm'));
  } catch {
    // fall through
  }
  for (let dir = process.cwd(), i = 0; i < 4; i++, dir = dirname(dir)) {
    candidates.push(join(dir, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm'));
  }
  const found = candidates.find((c) => existsSync(join(c, 'tree-sitter.wasm')));
  if (!found) throw new Error(`Could not find @vscode/tree-sitter-wasm grammars. Looked in:\n${candidates.join('\n')}`);
  return found;
}

/** Tree-sitter code parser using the grammars bundled in `@vscode/tree-sitter-wasm`. */
export function createNodeCodeParser(opts: { wasmDir?: string } = {}): CodeParser {
  if (opts.wasmDir || !defaultParser) {
    const ts = require('@vscode/tree-sitter-wasm') as TreeSitterModule;
    // Paths are joined at runtime so bundlers don't try to pull every grammar into the bundle.
    const wasmDir = opts.wasmDir ?? defaultWasmDir();
    const parser = createTreeSitterParser(ts, async (grammar) => readFile(join(wasmDir, `tree-sitter-${grammar}.wasm`)));
    if (opts.wasmDir) return parser;
    defaultParser = parser;
  }
  return defaultParser!;
}

function withParser(opts: IngestOptions): IngestOptions {
  return opts.codeParser ? opts : { ...opts, codeParser: createNodeCodeParser() };
}

/** Ingest a single file from disk. */
export async function ingestFile(path: string, opts: IngestOptions = {}): Promise<IngestResult> {
  return ingest({ name: basename(path), data: await readFile(path) }, withParser(opts));
}

/**
 * Ingest a directory recursively (e.g. a git checkout), skipping dependencies, build output,
 * VCS folders, lockfiles and binaries. Paths are kept relative to the directory, under its name.
 */
export async function ingestDirectory(dir: string, opts: IngestOptions = {}): Promise<IngestResult> {
  const o = withParser(opts);
  const maxBytes = o.maxFileBytes ?? 1_000_000;
  const root = basename(dir.replace(/[\\/]+$/, ''));
  const result: IngestResult = { artifacts: [], warnings: [] };

  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = relative(dir, full).split(sep).join('/');
      if (entry.isDirectory()) {
        if (!isIgnoredPath(`${rel}/x`)) await walk(full);
        continue;
      }
      if (!entry.isFile() || isIgnoredPath(rel)) continue;
      const size = (await stat(full)).size;
      if (size > maxBytes) {
        result.warnings.push(`${rel}: skipped (${Math.round(size / 1024)} KB exceeds limit)`);
        continue;
      }
      const data = await readFile(full);
      const fmt = detectFormat({ name: rel, data });
      if (fmt === 'unknown' || fmt === 'zip') continue;
      const r = await ingest({ name: rel, data }, { ...o, prefix: undefined });
      for (const a of r.artifacts) {
        const isChat = a.format === 'chatgpt' || a.format === 'claude';
        result.artifacts.push({ ...a, path: isChat ? joinPath(o.prefix, a.path) : joinPath(o.prefix, root, rel), sourceName: rel });
      }
      result.warnings.push(...r.warnings);
    }
  }
  await walk(dir);
  result.artifacts.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

export * from './index.js';
