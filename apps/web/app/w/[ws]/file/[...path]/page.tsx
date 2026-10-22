import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Breadcrumb, KindSign } from '@/components/Bits';
import { DocView, outline } from '@/components/DocView';
import { Header } from '@/components/Header';
import { currentUser, getWorkspace, param, pickBranch } from '@/lib/data';
import { KIND_LABEL, qs, relativeTime, short, shortDate, truncate } from '@/lib/format';
import { fileHref } from '@/lib/workspace';
import { deleteFile } from '../../actions';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ ws: string; path: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export default async function FilePage({ params, searchParams }: Props) {
  const { ws: slug, path: segments } = await params;
  const sp = await searchParams;
  const path = segments.map(decode).join('/');
  const [ws, user] = await Promise.all([getWorkspace(slug), currentUser()]);
  const { branch, branches } = await pickBranch(ws, sp['b']);
  const bq = branch === 'main' ? undefined : branch;
  const head = branches[branch]!;
  const at = param(sp['at']);
  const rev = at ?? branch;

  const doc = await ws.repo.readDoc(rev, path).catch(() => undefined);
  if (!doc) notFound();

  const stops = (await ws.repo.log(branch, { path })).reverse();
  const viewing = at ? await ws.repo.resolve(at) : head;
  const viewIdx = stops.findIndex((s) => s.hash === viewing);
  const lastChange = viewIdx >= 0 ? stops[viewIdx] : stops.at(-1);
  const prevStop = viewIdx > 0 ? stops[viewIdx - 1] : viewIdx === -1 ? stops.at(-2) : undefined;
  const isLatest = !at || viewing === head;
  const toc = outline(doc);
  const meta = doc.meta ?? {};

  return (
    <>
      <Header user={user} returnTo={fileHref(slug, path, qs({ b: bq, at }))} workspace={ws.meta} active="map" branch={branch} />

      <div className="flex flex-col gap-3.5 px-6 pt-4 md:px-10">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
          <Breadcrumb items={[{ label: 'Map', href: `/w/${slug}${qs({ b: bq })}` }, ...path.split('/').slice(0, -1).map((p) => ({ label: p }))]} />
          <h1 className="m-0 text-[26px] font-extrabold tracking-[-0.02em]">{doc.kind === 'chat' || doc.kind === 'pdf' ? (doc.title ?? path.split('/').pop()) : path.split('/').pop()}</h1>
          <KindSign kind={doc.kind} />
          <div className="flex-1" />
          {doc.kind === 'prose' && isLatest && (
            <Link href={`/w/${slug}/edit${qs({ b: bq, path })}`} className="btn-ink min-h-10">
              Edit
            </Link>
          )}
          {prevStop && (
            <Link href={`/w/${slug}/compare${qs({ from: prevStop.hash, to: viewing, path, b: bq })}`} className="btn-line min-h-10">
              Compare with previous version
            </Link>
          )}
        </div>

        <div aria-label="This file's stops" className="flex items-center overflow-x-auto border-b-2 border-ink pt-1 pb-3.5">
          <span className="eyebrow mr-4 shrink-0 text-xs">This file&rsquo;s stops</span>
          {stops.map((s, i) => {
            const isView = s.hash === viewing || (viewIdx === -1 && i === stops.length - 1 && isLatest);
            return (
              <span key={s.hash} className="flex shrink-0 items-center">
                {i > 0 && <span aria-hidden className="h-1.5 w-10 bg-line-main" />}
                <Link
                  href={fileHref(slug, path, qs({ b: bq, at: i === stops.length - 1 ? undefined : s.hash }))}
                  className="flex items-center gap-2 px-1 text-ink no-underline hover:text-ink"
                  aria-current={isView ? 'true' : undefined}
                  title={`${s.commit.message} · ${s.commit.author.name}`}
                >
                  <span
                    aria-hidden
                    className={`box-border inline-block rounded-full border-ink ${isView ? 'size-[18px] border-4 bg-ink shadow-[0_0_0_2px_#FAFAF7_inset]' : 'size-3.5 border-[3px] bg-paper'}`}
                  />
                  <span className={`text-xs ${isView ? 'font-extrabold' : ''}`}>
                    {truncate(s.commit.message, 26)} · {shortDate(s.commit.timestamp)}
                  </span>
                </Link>
              </span>
            );
          })}
        </div>
      </div>

      {!isLatest && (
        <div className="mx-6 mt-4 flex flex-wrap items-center gap-3 rounded bg-warn-bg px-4 py-2.5 md:mx-10">
          <b>Viewing an older version</b> (stop {short(viewing)}).
          <Link href={fileHref(slug, path, qs({ b: bq }))} className="font-bold">
            Back to latest
          </Link>
        </div>
      )}

      <div className="flex flex-wrap">
        <main className="flex min-w-0 flex-[999_1_560px] flex-col gap-4 px-6 py-7 md:pl-10">
          <DocView doc={doc} />
        </main>

        <aside aria-label="Details" className="flex max-w-[340px] min-w-[260px] flex-1 flex-col gap-6 border-l border-rule px-6 py-7 md:pr-10">
          {toc.length > 0 && (
            <section className="flex flex-col gap-1">
              <div className="eyebrow mb-1">{doc.kind === 'code' ? 'Symbols' : 'Outline'}</div>
              {toc.map((t, i) => (
                <a key={i} href={t.anchor ? `#${t.anchor}` : undefined} className="flex min-h-8 items-center gap-2.5 text-ink no-underline hover:text-line-main">
                  {t.kind && <span className="w-14 shrink-0 text-[11px] font-extrabold text-muted uppercase">{t.kind}</span>}
                  {t.label}
                </a>
              ))}
            </section>
          )}

          <section className="flex flex-col gap-2">
            <div className="eyebrow">About</div>
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 gap-y-1.5">
              <dt className="text-muted">Type</dt>
              <dd className="m-0">{KIND_LABEL[doc.kind]}</dd>
              <dt className="text-muted">Path</dt>
              <dd className="m-0 font-mono text-xs break-all">{path}</dd>
              {typeof meta['source'] === 'string' && (
                <>
                  <dt className="text-muted">Source</dt>
                  <dd className="m-0">{({ chatgpt: 'ChatGPT export', claude: 'Claude export', pdf: 'PDF text extraction', markdown: 'Markdown', text: 'Plain text' } as Record<string, string>)[meta['source']] ?? String(meta['source'])}</dd>
                </>
              )}
              {typeof meta['models'] === 'string' && (
                <>
                  <dt className="text-muted">Model</dt>
                  <dd className="m-0">{meta['models']}</dd>
                </>
              )}
              {typeof meta['pages'] === 'number' && (
                <>
                  <dt className="text-muted">Pages</dt>
                  <dd className="m-0">{meta['pages']}</dd>
                </>
              )}
              {typeof meta['language'] === 'string' && (
                <>
                  <dt className="text-muted">Language</dt>
                  <dd className="m-0">{meta['language']}</dd>
                </>
              )}
              <dt className="text-muted">Units</dt>
              <dd className="m-0">{doc.units.length}</dd>
            </dl>
          </section>

          {lastChange && (
            <section className="card flex flex-col gap-1.5 p-4">
              <div className="eyebrow">Last changed</div>
              <div>
                <b>{lastChange.commit.message}</b>
              </div>
              <div className="text-muted">
                {lastChange.commit.author.name} · {relativeTime(lastChange.commit.timestamp)} · <span className="font-mono">{short(lastChange.hash)}</span>
              </div>
              <div className="text-muted">Changed in {stops.length} {stops.length === 1 ? 'stop' : 'stops'} on {branch}</div>
            </section>
          )}

          {isLatest && (
            <form action={deleteFile}>
              <input type="hidden" name="ws" value={slug} />
              <input type="hidden" name="branch" value={branch} />
              <input type="hidden" name="path" value={path} />
              <button className="cursor-pointer border-0 bg-transparent p-0 font-semibold text-del-fg underline">Remove from {branch}</button>
            </form>
          )}
        </aside>
      </div>
    </>
  );
}
