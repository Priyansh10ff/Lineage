import Link from 'next/link';
import { BranchPicker, ErrorBanner } from '@/components/Bits';
import { Header } from '@/components/Header';
import { LineLegend, TransitMap } from '@/components/TransitMap';
import { currentUser, getWorkspace, param, pickBranch } from '@/lib/data';
import { cleanSummary, plural, qs, relativeTime, short } from '@/lib/format';
import { fileHref } from '@/lib/workspace';
import { createBranch } from '../actions';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const STATUS_STYLE: Record<string, string> = {
  modified: 'text-line-main',
  added: 'text-ins-fg',
  removed: 'text-del-fg',
  renamed: 'text-muted',
};

export default async function HistoryPage({ params, searchParams }: Props) {
  const { ws: slug } = await params;
  const sp = await searchParams;
  const [ws, user] = await Promise.all([getWorkspace(slug), currentUser()]);
  const { branch, branches } = await pickBranch(ws, sp['b']);
  const bq = branch === 'main' ? undefined : branch;
  const head = branches[branch]!;

  const graph = await ws.repo.graph();
  const requested = param(sp['sel']);
  const sel = requested && graph.nodes.some((n) => n.hash === requested) ? requested : head;
  const node = graph.nodes.find((n) => n.hash === sel)!;
  const commit = node.commit;
  const parent = commit.parents[0];
  const diff = await ws.repo.diff(parent ?? null, sel);
  const lane = graph.lanes.find((l) => l.index === node.lane)!;
  const log = await ws.repo.log(branch, { limit: 60 });
  const filesAt = Object.keys(await ws.repo.getTree(sel));
  const isMerge = commit.parents.length > 1;

  return (
    <>
      <Header user={user} returnTo={`/w/${slug}/history${qs({ b: bq, sel: requested })}`} workspace={ws.meta} active="history" branch={branch} />

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-6 pt-5 md:px-10">
        <h1 className="m-0 text-[28px] font-extrabold tracking-[-0.02em]">History</h1>
        <span className="text-muted">
          {plural(graph.nodes.length, 'stop')} on {plural(graph.lanes.length, 'line')}
        </span>
        <div className="flex-1" />
        <BranchPicker branches={Object.keys(branches)} current={branch} action={`/w/${slug}/history`} />
      </div>

      <section aria-label="Full map" className="map-paper mx-6 mt-3.5 flex flex-col gap-2 rounded-md border-2 border-ink px-4 pt-3 md:mx-10">
        <LineLegend graph={graph} />
        <TransitMap graph={graph} current={head} selected={sel} hrefFor={(h) => `/w/${slug}/history${qs({ b: bq, sel: h })}`} />
      </section>

      <div className="flex flex-wrap gap-6 px-6 pt-6 pb-10 md:px-10">
        <section aria-label="Selected stop" className="card flex min-w-0 flex-[999_1_520px] flex-col gap-4 p-6">
          <ErrorBanner message={param(sp['error'])} />
          <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1.5">
            {isMerge && <span className="sign bg-[#F08A24] text-ink">INTERCHANGE</span>}
            <h2 className="m-0 text-2xl font-extrabold">{commit.message}</h2>
            <span className="font-mono text-muted">{short(sel)}</span>
          </div>
          <div className="text-[#3D4048]">
            {commit.author.name}
            {commit.author.kind === 'agent' && <span className="ml-1.5 rounded bg-[#D7EFE6] px-1.5 text-xs font-bold text-agent">AGENT</span>} ·{' '}
            {new Date(commit.timestamp).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })} ({relativeTime(commit.timestamp)}) · on <b>{lane.name}</b>
            {commit.parents.length > 0 && (
              <>
                {' '}
                · {commit.parents.length > 1 ? 'parents' : 'parent'}{' '}
                {commit.parents.map((p, i) => (
                  <span key={p}>
                    {i > 0 && ' and '}
                    <Link href={`/w/${slug}/history${qs({ b: bq, sel: p })}`} className="font-mono">
                      {short(p)}
                    </Link>
                  </span>
                ))}
              </>
            )}
          </div>

          <div className="flex flex-col border-t border-rule">
            {diff.files.length === 0 && <p className="text-muted">No file changes {isMerge ? 'compared with the first parent' : ''}.</p>}
            {diff.files.map((f) => (
              <div key={f.path} className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 border-b border-rule py-3">
                <span className={`text-xs font-extrabold uppercase ${STATUS_STYLE[f.status]}`}>{f.status}</span>
                <span>
                  <Link href={fileHref(slug, f.path, qs({ b: bq, at: sel }))} className="font-bold text-ink">
                    {f.path}
                  </Link>
                  {f.oldPath && <span className="text-muted"> from {f.oldPath}</span>}
                  {f.diff.summary.length > 0 && <span className="text-[#3D4048]"> · {f.diff.summary.slice(0, 3).map(cleanSummary).join('; ')}{f.diff.summary.length > 3 ? '; …' : ''}</span>}
                </span>
              </div>
            ))}
            {isMerge && diff.files.length > 0 && <p className="mb-0 text-muted">Changes shown against the first parent, i.e. what the merge brought in.</p>}
          </div>

          <div className="flex flex-wrap gap-2.5">
            {sel !== head && (
              <Link href={`/w/${slug}/compare${qs({ from: sel, to: head, b: bq })}`} className="btn-ink">
                Compare with latest on {branch}
              </Link>
            )}
            {parent && (
              <Link href={`/w/${slug}/compare${qs({ from: parent, to: sel, b: bq })}`} className="btn-line">
                Full diff of this stop
              </Link>
            )}
          </div>

          <details className="rounded border border-rule px-4 py-3">
            <summary className="cursor-pointer font-bold">Open the workspace as of this stop ({plural(filesAt.length, 'file')})</summary>
            <ul className="mt-2 mb-0 flex list-none flex-col gap-1 p-0">
              {filesAt.map((p) => (
                <li key={p}>
                  <Link href={fileHref(slug, p, qs({ b: bq, at: sel }))}>{p}</Link>
                </li>
              ))}
            </ul>
          </details>

          <form action={createBranch} className="flex flex-wrap items-end gap-2.5 border-t border-rule pt-4">
            <input type="hidden" name="ws" value={slug} />
            <input type="hidden" name="from" value={sel} />
            <input type="hidden" name="back" value={`/w/${slug}/history${qs({ b: bq, sel })}`} />
            <label className="flex min-w-[240px] flex-1 flex-col gap-1">
              <span className="font-bold">Start a branch here</span>
              <input name="name" required placeholder={`${user.id}/from-${short(sel)}`} pattern="[A-Za-z0-9._/\-]+" className="field" />
            </label>
            <button className="btn-line">Create branch</button>
          </form>
        </section>

        <section aria-label="All stops" className="flex max-w-[440px] min-w-[300px] flex-1 flex-col">
          <div className="eyebrow border-b-2 border-ink pb-2">Stops on {branch}, newest first</div>
          {log.map((e) => (
            <Link
              key={e.hash}
              href={`/w/${slug}/history${qs({ b: bq, sel: e.hash })}`}
              aria-current={e.hash === sel ? 'true' : undefined}
              className={`grid min-h-12 grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-rule px-1 text-ink no-underline hover:bg-panel hover:text-ink ${e.hash === sel ? 'bg-warn-bg font-bold' : ''}`}
            >
              <span aria-hidden className={`size-3 ${e.commit.parents.length > 1 ? 'rounded-[3px] bg-[#F08A24]' : 'rounded-full bg-line-main'}`} />
              <span className="truncate">
                {e.commit.message} <span className="font-normal text-muted">· {e.commit.author.name}</span>
              </span>
              <span className="font-mono text-xs text-muted">{short(e.hash)}</span>
            </Link>
          ))}
        </section>
      </div>
    </>
  );
}
