import 'server-only';
import type { Doc, Hash } from '@lineage/core';
import type { Workspace } from '@lineage/store-fs';

export interface FileEntry {
  path: string;
  hash: Hash;
  kind: Doc['kind'];
  title?: string;
  units: number;
}

/** Files on a revision with their kind and title (reads each blob; fine at workspace scale). */
export async function listFiles(ws: Workspace, rev: string): Promise<FileEntry[]> {
  const tree = await ws.repo.getTree(rev);
  const out: FileEntry[] = [];
  for (const [path, hash] of Object.entries(tree)) {
    const doc = await ws.repo.readBlob(hash);
    out.push({ path, hash, kind: doc.kind, units: doc.units.length, ...(doc.title ? { title: doc.title } : {}) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function fileHref(slug: string, path: string, params = ''): string {
  return `/w/${slug}/file/${path.split('/').map(encodeURIComponent).join('/')}${params}`;
}

/** Branches with commits that the given branch doesn't have yet. */
export async function unmergedLines(ws: Workspace, into: string): Promise<{ name: string; ahead: number; behind: number }[]> {
  const branches = await ws.repo.branches();
  const out: { name: string; ahead: number; behind: number }[] = [];
  for (const name of Object.keys(branches)) {
    if (name === into) continue;
    const ahead = (await ws.repo.commitsBetween(into, name)).length;
    if (!ahead) continue;
    const behind = (await ws.repo.commitsBetween(name, into)).length;
    out.push({ name, ahead, behind });
  }
  return out;
}
