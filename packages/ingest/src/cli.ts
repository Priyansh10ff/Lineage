#!/usr/bin/env node
/**
 * lineage-ingest <file-or-directory>... [--json]
 * Prints what Lineage would store for each input: workspace path, format, unit count and title.
 */
import { stat } from 'node:fs/promises';
import { ingestDirectory, ingestFile } from './node.js';
import type { IngestResult } from './types.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const inputs = args.filter((a) => !a.startsWith('--'));

if (!inputs.length) {
  console.error('usage: lineage-ingest <file-or-directory>... [--json]');
  process.exit(1);
}

const all: IngestResult = { artifacts: [], warnings: [] };
for (const input of inputs) {
  let isDir: boolean;
  try {
    isDir = (await stat(input)).isDirectory();
  } catch {
    all.warnings.push(`${input}: no such file or directory`);
    continue;
  }
  const r = isDir ? await ingestDirectory(input) : await ingestFile(input);
  all.artifacts.push(...r.artifacts);
  all.warnings.push(...r.warnings);
}

if (json) {
  console.log(JSON.stringify(all, null, 2));
} else {
  for (const a of all.artifacts) {
    const title = a.doc.title && a.doc.title !== a.path ? `  "${a.doc.title}"` : '';
    console.log(`${a.format.padEnd(13)} ${String(a.doc.units.length).padStart(4)} units  ${a.path}${title}`);
  }
  for (const w of all.warnings) console.warn(`warning: ${w}`);
  console.log(`\n${all.artifacts.length} artifact(s)`);
}
if (!all.artifacts.length) process.exitCode = 1;
