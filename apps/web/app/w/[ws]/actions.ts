'use server';

import {
  LineageError,
  NothingToCommitError,
  RefConflictError,
  UnresolvedConflictsError,
  mergeDocs,
  parseProse,
  renderDoc,
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

// ------------------------------------------------------------------ live drafts

export type DraftCommitResult =
  | {
      ok: true;
      head: string;
      branch: string;
      /** Nothing differed from the branch. */
      unchanged?: boolean;
      /** The draft should now read this: the merged text that was committed, or (for a new line) the original branch's text. */
      adoptText?: string;
      /** Set when the draft went onto a new line. */
      newLine?: string;
    }
  | { ok: false; error: string; conflict?: boolean };

export interface DraftCommitInput {
  ws: string;
  branch: string;
  path: string;
  text: string;
  /** Commit the draft was last in sync with. */
  base: string;
  message: string;
  /** Put the draft on a new line from `base` instead of merging into `branch`. */
  asNewLine?: boolean;
}

const validPath = (p: string) => !!p && !p.startsWith('/') && !p.split('/').some((s) => !s || s === '.' || s === '..');

/**
 * Commit a shared draft. If the branch moved since the draft's base, the draft is merged with
 * the new head (paragraph and sentence level); a real conflict is reported instead, and the
 * caller can put the draft on its own line to resolve it on the merge page.
 */
export async function commitDraft(input: DraftCommitInput): Promise<DraftCommitResult> {
  const ws = await registry.get(input.ws);
  if (!ws) return { ok: false, error: 'Workspace not found.' };
  const path = input.path.replace(/^\/+/, '');
  if (!validPath(path)) return { ok: false, error: 'Give the file a path, e.g. docs/notes.md' };
  const author = asAuthor(await currentUser());
  const message = input.message.trim() || `Edit ${path}`;
  const ours = parseProse(input.text);

  try {
    if (input.asNewLine) {
      const stem = path.split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'draft';
      const branches = await ws.repo.branches();
      let name = `${author.id}/${stem}`;
      for (let i = 2; name in branches; i++) name = `${author.id}/${stem}-${i}`;
      await ws.repo.createBranch(name, input.base);
      const head = await ws.repo.commit({ branch: name, author, message, changes: { [path]: ours } });
      // The shared draft goes back to what the original line says; the edits live on the new line.
      const original = (await ws.repo.branches())[input.branch];
      const back = original ? await ws.repo.readDoc(original, path) : undefined;
      revalidatePath(`/w/${input.ws}`);
      return { ok: true, head, branch: input.branch, newLine: name, ...(back ? { adoptText: renderDoc(back) } : {}) };
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const head = (await ws.repo.branches())[input.branch];
      if (!head) return { ok: false, error: `The ${input.branch} line no longer exists.` };
      const theirs = (await ws.repo.readDoc(head, path)) ?? null;
      if (theirs && theirs.kind !== 'prose') return { ok: false, error: `${path} is not a document you can edit here.` };

      let doc = ours;
      let adoptText: string | undefined;
      if (head !== input.base) {
        const baseDoc = (await ws.repo.readDoc(input.base, path).catch(() => undefined)) ?? null;
        const merged = mergeDocs(baseDoc, ours, theirs);
        if (merged.status === 'conflict') {
          return {
            ok: false,
            conflict: true,
            error: `Your edits and the latest commit on ${input.branch} change the same paragraph.`,
          };
        }
        if (!merged.doc) return { ok: false, error: `${path} was removed on ${input.branch} since this draft started.` };
        doc = merged.doc;
        adoptText = renderDoc(doc);
      }
      try {
        const next = await ws.repo.commit({ branch: input.branch, author, message, changes: { [path]: doc }, expectedHead: head });
        revalidatePath(`/w/${input.ws}`);
        return { ok: true, head: next, branch: input.branch, ...(adoptText !== undefined ? { adoptText } : {}) };
      } catch (e) {
        if (e instanceof NothingToCommitError) return { ok: true, head, branch: input.branch, unchanged: true, ...(adoptText !== undefined ? { adoptText } : {}) };
        // Someone committed between our read and write: merge again against the new head.
        if (e instanceof RefConflictError) continue;
        throw e;
      }
    }
    return { ok: false, error: `${input.branch} is changing quickly right now. Try again in a moment.` };
  } catch (e) {
    return { ok: false, error: e instanceof LineageError ? e.message : (e as Error).message };
  }
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
