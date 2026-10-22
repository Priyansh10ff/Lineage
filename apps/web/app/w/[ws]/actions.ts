'use server';

import {
  LineageError,
  NothingToCommitError,
  RefConflictError,
  UnresolvedConflictsError,
  parseProse,
  type ConflictChoice,
  type Doc,
  type Unit,
} from '@lineage/core';
import { createNodeCodeParser, ingest, type IngestResult } from '@lineage/ingest/node';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { currentUser, getWorkspace, registry } from '@/lib/data';
import { qs } from '@/lib/format';
import { asAuthor } from '@/lib/users';
import { fileHref } from '@/lib/workspace';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const b = (branch: string) => (branch === 'main' ? undefined : branch);
const withError = (url: string, msg: string) => `${url}${url.includes('?') ? '&' : '?'}error=${encodeURIComponent(msg)}`;

export async function createBranch(form: FormData): Promise<void> {
  const slug = str(form, 'ws');
  const ws = await getWorkspace(slug);
  const name = str(form, 'name');
  const from = str(form, 'from') || 'main';
  const back = str(form, 'back') || `/w/${slug}`;
  try {
    await ws.repo.createBranch(name, from);
  } catch (e) {
    redirect(withError(back, (e as Error).message));
  }
  revalidatePath(`/w/${slug}`);
  redirect(`/w/${slug}${qs({ b: b(name) })}`);
}

export async function markSeen(form: FormData): Promise<void> {
  const slug = str(form, 'ws');
  const branch = str(form, 'branch') || 'main';
  const ws = await getWorkspace(slug);
  const user = await currentUser();
  await registry.markSeen(slug, user.id, branch, await ws.repo.resolve(branch));
  revalidatePath(`/w/${slug}`);
  redirect(`/w/${slug}${qs({ b: b(branch) })}`);
}

/** Commit an edited (or new) prose document. Rejected if the branch moved since the editor opened. */
export async function saveDocument(form: FormData): Promise<void> {
  const slug = str(form, 'ws');
  const branch = str(form, 'branch') || 'main';
  const path = str(form, 'path').replace(/^\/+/, '');
  const text = String(form.get('text') ?? '');
  const message = str(form, 'message') || `Edit ${path}`;
  const expectedHead = str(form, 'head');
  const ws = await getWorkspace(slug);
  const back = `/w/${slug}/edit${qs({ path, b: b(branch) })}`;
  if (!path) redirect(withError(back, 'Give the file a path, e.g. docs/notes.md'));
  const doc = parseProse(text);
  try {
    await ws.repo.commit({ branch, author: asAuthor(await currentUser()), message, changes: { [path]: doc }, ...(expectedHead ? { expectedHead } : {}) });
  } catch (e) {
    const msg =
      e instanceof RefConflictError
        ? 'Someone committed to this branch while you were editing. Your text is below; copy it, reload, and apply it again.'
        : e instanceof NothingToCommitError
          ? 'Nothing changed.'
          : (e as Error).message;
    redirect(withError(back, msg));
  }
  revalidatePath(`/w/${slug}`);
  redirect(fileHref(slug, path, qs({ b: b(branch) })));
}

export async function deleteFile(form: FormData): Promise<void> {
  const slug = str(form, 'ws');
  const branch = str(form, 'branch') || 'main';
  const path = str(form, 'path');
  const ws = await getWorkspace(slug);
  await ws.repo.commit({ branch, author: asAuthor(await currentUser()), message: `Remove ${path}`, changes: { [path]: null } });
  revalidatePath(`/w/${slug}`);
  redirect(`/w/${slug}${qs({ b: b(branch) })}`);
}

// ------------------------------------------------------------------ import

export interface StagedImport {
  result: IngestResult;
  uploaded: { name: string; size: number }[];
}

export async function stageImport(form: FormData): Promise<void> {
  const slug = str(form, 'ws');
  const branch = str(form, 'branch') || 'main';
  const prefix = str(form, 'prefix') || undefined;
  await getWorkspace(slug);
  const files = form.getAll('files').filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f && f.size > 0);
  if (!files.length) redirect(`/w/${slug}/import${qs({ b: b(branch), error: 'Choose at least one file.' })}`);

  const codeParser = createNodeCodeParser();
  const result: IngestResult = { artifacts: [], warnings: [] };
  for (const f of files) {
    const r = await ingest({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }, { codeParser, ...(prefix ? { prefix } : {}) });
    result.artifacts.push(...r.artifacts);
    result.warnings.push(...r.warnings);
  }
  const id = await registry.stage<StagedImport>(slug, { result, uploaded: files.map((f) => ({ name: f.name, size: f.size })) });
  redirect(`/w/${slug}/import${qs({ b: b(branch), staged: id })}`);
}

export async function commitImport(form: FormData): Promise<void> {
  const slug = str(form, 'ws');
  const id = str(form, 'staged');
  const branch = str(form, 'branch') || 'main';
  const message = str(form, 'message') || 'Import files';
  const ws = await getWorkspace(slug);
  const staged = await registry.readStage<StagedImport>(slug, id);
  if (!staged) redirect(`/w/${slug}/import${qs({ error: 'That upload expired. Upload the files again.' })}`);
  const keep = new Set(form.getAll('keep').map(String));
  const changes: Record<string, Doc> = {};
  for (const a of staged.result.artifacts) if (keep.has(a.path)) changes[a.path] = a.doc;
  try {
    await ws.repo.commit({ branch, author: asAuthor(await currentUser()), message, changes });
  } catch (e) {
    const msg = e instanceof NothingToCommitError ? 'Those files are already in the workspace, unchanged.' : (e as Error).message;
    redirect(`/w/${slug}/import${qs({ b: b(branch), staged: id, error: msg })}`);
  }
  await registry.dropStage(slug, id);
  revalidatePath(`/w/${slug}`);
  redirect(`/w/${slug}${qs({ b: b(branch) })}`);
}

// ------------------------------------------------------------------ merge

function customUnits(text: string, template: Unit | undefined): Unit[] {
  if (!template || template.type === 'heading' || template.type === 'paragraph' || template.type === 'list' || template.type === 'quote') {
    return parseProse(text).units;
  }
  // Chat turns, PDF paragraphs, code: keep the unit type and metadata of the side it was based on.
  return text
    .split(/\n\s*\n/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({ ...template, text: t }));
}

export async function completeMergeAction(form: FormData): Promise<void> {
  const slug = str(form, 'ws');
  const into = str(form, 'into');
  const from = str(form, 'from');
  const ws = await getWorkspace(slug);
  const back = `/w/${slug}/merge${qs({ into, from })}`;
  const fail = (msg: string): never => redirect(withError(back, msg));

  const preview = await ws.repo.previewMerge({ into, from, message: str(form, 'message') || undefined });
  if (preview.status !== 'ready') return fail('Nothing to merge any more.');
  const { draft } = preview;
  if (draft.oursHead !== str(form, 'oursHead') || draft.theirsHead !== str(form, 'theirsHead')) {
    return fail('One of the branches moved while you were reviewing. Here is the updated merge.');
  }

  const resolutions: Record<string, Record<string, ConflictChoice>> = {};
  for (const [path, file] of Object.entries(draft.conflicts)) {
    for (const r of file.regions) {
      if (r.type !== 'conflict') continue;
      const key = `${path}::${r.id}`;
      const choice = str(form, `choice:${key}`);
      if (!choice) continue;
      const target = (resolutions[path] ??= {});
      if (choice === 'custom') {
        target[r.id] = { units: customUnits(String(form.get(`custom:${key}`) ?? ''), r.ours[0] ?? r.theirs[0] ?? r.base[0]) };
      } else if (['ours', 'theirs', 'base', 'ours-then-theirs', 'theirs-then-ours'].includes(choice)) {
        target[r.id] = choice as ConflictChoice;
      }
    }
  }

  let head: string;
  try {
    head = await ws.repo.completeMerge(draft, resolutions, asAuthor(await currentUser()));
  } catch (e) {
    if (e instanceof UnresolvedConflictsError) return fail('Pick a resolution for every conflict.');
    if (e instanceof RefConflictError) return fail(`${into} moved while you were resolving. Review the updated merge.`);
    if (e instanceof LineageError) return fail(e.message);
    throw e;
  }
  revalidatePath(`/w/${slug}`);
  redirect(`/w/${slug}/history${qs({ b: b(into), sel: head })}`);
}

export async function fastForwardAction(form: FormData): Promise<void> {
  const slug = str(form, 'ws');
  const into = str(form, 'into');
  const from = str(form, 'from');
  const ws = await getWorkspace(slug);
  const preview = await ws.repo.previewMerge({ into, from });
  if (preview.status === 'ready' && preview.canFastForward) await ws.repo.fastForward(preview.draft);
  revalidatePath(`/w/${slug}`);
  redirect(`/w/${slug}${qs({ b: b(into) })}`);
}

export async function deleteBranchAction(form: FormData): Promise<void> {
  const slug = str(form, 'ws');
  const name = str(form, 'name');
  const ws = await getWorkspace(slug);
  if (name !== 'main') await ws.repo.deleteBranch(name);
  revalidatePath(`/w/${slug}`);
  redirect(`/w/${slug}`);
}
