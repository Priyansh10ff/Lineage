import { renderDoc } from '@lineage/core';
import Link from 'next/link';
import { Breadcrumb, ErrorBanner } from '@/components/Bits';
import { Header } from '@/components/Header';
import { currentUser, getWorkspace, param, pickBranch } from '@/lib/data';
import { qs, short } from '@/lib/format';
import { fileHref } from '@/lib/workspace';
import { saveDocument } from '../actions';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function EditPage({ params, searchParams }: Props) {
  const { ws: slug } = await params;
  const sp = await searchParams;
  const [ws, user] = await Promise.all([getWorkspace(slug), currentUser()]);
  const { branch, branches } = await pickBranch(ws, sp['b']);
  const bq = branch === 'main' ? undefined : branch;
  const path = param(sp['path']);
  const doc = path ? await ws.repo.readDoc(branch, path) : undefined;
  const isNew = !doc;
  const editable = !doc || doc.kind === 'prose';

  return (
    <>
      <Header user={user} returnTo={`/w/${slug}/edit${qs({ b: bq, path })}`} workspace={ws.meta} active="map" branch={branch} />
      <main className="mx-auto box-border flex w-full max-w-[980px] flex-col gap-5 px-6 py-7">
        <Breadcrumb items={[{ label: 'Map', href: `/w/${slug}${qs({ b: bq })}` }, ...(path && !isNew ? [{ label: path, href: fileHref(slug, path, qs({ b: bq })) }] : [])]} />
        <h1 className="m-0 text-[28px] font-extrabold tracking-[-0.02em]">{isNew ? 'New note' : `Edit ${path}`}</h1>
        <ErrorBanner message={param(sp['error'])} />
        {!editable ? (
          <p className="m-0">
            {doc!.kind === 'chat' ? 'Chats' : doc!.kind === 'pdf' ? 'PDFs' : 'Code files'} are edited where they came from. Import a newer version and Lineage records it as a change.{' '}
            <Link href={`/w/${slug}/import${qs({ b: bq })}`}>Import a new version</Link>
          </p>
        ) : (
          <form action={saveDocument} className="flex flex-col gap-4">
            <input type="hidden" name="ws" value={slug} />
            <input type="hidden" name="branch" value={branch} />
            <input type="hidden" name="head" value={branches[branch]} />
            {isNew ? (
              <label className="flex flex-col gap-1">
                <span className="font-bold">Path</span>
                <input name="path" required defaultValue={path ?? 'docs/notes.md'} className="field font-mono" />
              </label>
            ) : (
              <input type="hidden" name="path" value={path} />
            )}
            <label className="flex flex-col gap-1">
              <span className="font-bold">
                Markdown <span className="font-normal text-muted">· paragraphs are separated by a blank line</span>
              </span>
              <textarea
                name="text"
                rows={22}
                defaultValue={doc ? renderDoc(doc) : '# Title\n\nWrite here.'}
                className="field py-3 font-mono text-[14px] leading-relaxed"
              />
            </label>
            <div className="flex flex-wrap items-end gap-3 border-t-2 border-ink pt-4">
              <label className="flex min-w-[280px] flex-1 flex-col gap-1">
                <span className="font-bold">Commit message</span>
                <input name="message" className="field" placeholder={isNew ? `Add ${path ?? 'a note'}` : `Edit ${path}`} />
              </label>
              <span className="pb-3 text-muted">
                to <b className="text-ink">{branch}</b> after {short(branches[branch]!)}
              </span>
              <button className="btn-ink">Commit</button>
            </div>
            <p className="m-0 text-muted">
              If someone commits to {branch} while you edit, Lineage refuses this commit instead of overwriting theirs. Live co-editing comes with the real-time layer.
            </p>
          </form>
        )}
      </main>
    </>
  );
}
