import Link from 'next/link';
import { Avatar } from '@/components/Avatar';
import { BranchPicker, ErrorBanner, KindSign } from '@/components/Bits';
import { DiffView } from '@/components/DiffView';
import { Header } from '@/components/Header';
import { LineLegend, TransitMap } from '@/components/TransitMap';
import { currentUser, getWorkspace, param, pickBranch } from '@/lib/data';
import { plural, qs, relativeTime, short } from '@/lib/format';
import { fileHref, listFiles, unmergedLines } from '@/lib/workspace';
import { createBranch, markSeen } from './actions';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props) {
  const { ws } = await params;
  return { title: ws };
}

export default async function WorkspaceMap({ params, searchParams }: Props) {
  const { ws: slug } = await params;
  const sp = await searchParams;
  const [ws, user] = await Promise.all([getWorkspace(slug), currentUser()]);
  const { branch, branches } = await pickBranch(ws, sp['b']);
  const bq = branch === 'main' ? undefined : branch;
  const head = branches[branch]!;

  const [graph, files, log, pending] = await Promise.all([
    ws.repo.graph(),
    listFiles(ws, branch),
    ws.repo.log(branch, { limit: 1 }),
    unmergedLines(ws, branch),
  ]);
  const latest = log[0]!;
  const parent = latest.commit.parents[0];
  const latestDiff = parent ? await ws.repo.diff(parent, latest.hash) : null;

  const seen = ws.meta.lastSeen[user.id]?.[branch];
  const since = seen && seen !== head ? await ws.repo.commitsBetween(seen, branch).catch(() => []) : [];
  const sinceFiles = since.length && seen ? (await ws.repo.diff(seen, branch)).files.length : 0;

  const groups: [string, typeof files][] = [
    ['Documents', files.filter((f) => f.kind === 'prose')],
    ['Chats', files.filter((f) => f.kind === 'chat')],
    ['Papers', files.filter((f) => f.kind === 'pdf')],
    ['Code', files.filter((f) => f.kind === 'code')],
  ];

  return (
    <>
      <Header user={user} returnTo={`/w/${slug}${qs({ b: bq })}`} workspace={ws.meta} active="map" branch={branch} />

      <section aria-label="Branch map" className="map-paper border-b-2 border-ink px-6 pt-5 pb-2 md:px-10">
        <div className="mb-2 flex flex-wrap items-center gap-x-6 gap-y-3">
          <span className="eyebrow">Lines</span>
          <LineLegend graph={graph} />
          <div className="flex-1" />
          <BranchPicker branches={Object.keys(branches)} current={branch} action={`/w/${slug}`} />
        </div>
        <TransitMap graph={graph} current={head} hrefFor={(h) => `/w/${slug}/history${qs({ b: bq, sel: h })}`} />
      </section>

      <div className="flex flex-wrap">
        <nav aria-label="Files" className="flex max-w-[340px] min-w-[260px] flex-1 flex-col gap-5 px-6 py-6 md:pl-10">
          <div className="flex items-baseline justify-between">
            <span className="eyebrow">Stops on {branch}</span>
            <span className="text-muted">{plural(files.length, 'file')}</span>
          </div>
          {files.length === 0 && (
            <p className="m-0 text-muted">
              Nothing here yet. <Link href={`/w/${slug}/import${qs({ b: bq })}`}>Import files</Link> or{' '}
              <Link href={`/w/${slug}/edit${qs({ b: bq, new: '1' })}`}>write a note</Link>.
            </p>
          )}
          {groups.map(([label, list]) =>
            list.length ? (
              <div key={label} className="flex flex-col">
                <div className="mb-1 text-xs font-extrabold tracking-[0.08em] text-muted uppercase">{label}</div>
                {list.map((f) => (
                  <Link
                    key={f.path}
                    href={fileHref(slug, f.path, qs({ b: bq }))}
                    className="flex min-h-11 items-center gap-2.5 border-b border-rule text-ink no-underline hover:bg-panel hover:text-ink"
                  >
                    <span aria-hidden className="box-border size-2.5 shrink-0 rounded-full border-[3px] border-ink" />
                    <span className="min-w-0 truncate" title={f.path}>
                      {f.kind === 'chat' || f.kind === 'pdf' ? (f.title ?? f.path) : f.path}
                    </span>
                  </Link>
                ))}
              </div>
            ) : null,
          )}
          <Link href={`/w/${slug}/edit${qs({ b: bq, new: '1' })}`} className="btn-line self-start">
            New note
          </Link>
        </nav>

        <main className="flex min-w-0 flex-[999_1_520px] flex-col gap-4 px-6 py-6">
          <ErrorBanner message={param(sp['error'])} />
          <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
            <h1 className="m-0 text-[28px] font-extrabold tracking-[-0.02em]">Latest stop: {latest.commit.message}</h1>
            <span className="font-mono text-muted">
              {short(latest.hash)} · {latest.commit.author.name} · {relativeTime(latest.commit.timestamp)}
            </span>
          </div>
          {latestDiff && latestDiff.files.length > 0 ? (
            <div className="flex flex-col gap-4">
              {latestDiff.files.slice(0, 3).map((f) => (
                <section key={f.path} className="card overflow-hidden">
                  <div className="flex flex-wrap items-center gap-3 border-b border-rule bg-panel px-5 py-2.5">
                    <KindSign kind={f.diff.kind} />
                    <Link href={fileHref(slug, f.path, qs({ b: bq }))} className="font-bold text-ink">
                      {f.path}
                    </Link>
                    <span className="text-muted">{f.status}</span>
                  </div>
                  {f.status === 'added' || f.status === 'removed' ? (
                    <p className="m-0 px-5 py-3 text-muted">
                      {f.status === 'added' ? 'New file' : 'File removed'} · {plural(f.diff.stats.added + f.diff.stats.removed, 'unit')}
                    </p>
                  ) : (
                    <DiffView diff={f.diff} />
                  )}
                </section>
              ))}
              {latestDiff.files.length > 3 && <p className="m-0 text-muted">and {latestDiff.files.length - 3} more files</p>}
              <Link href={`/w/${slug}/compare${qs({ from: parent, to: latest.hash, b: bq })}`} className="btn-ink self-start">
                Open full comparison
              </Link>
            </div>
          ) : (
            <p className="m-0 text-muted">This is the first stop on the line.</p>
          )}
        </main>

        <aside aria-label="Activity" className="flex max-w-[340px] min-w-[260px] flex-1 flex-col gap-5 px-6 py-6 md:pr-10">
          <section className="flex flex-col gap-2 rounded-md bg-ink p-4 text-paper">
            <div className="eyebrow text-header-muted">Since your last stop</div>
            {!seen ? (
              <>
                <div>Mark where you are, and next time this shows what others changed.</div>
                <form action={markSeen}>
                  <input type="hidden" name="ws" value={slug} />
                  <input type="hidden" name="branch" value={branch} />
                  <button className="btn min-h-10 bg-paper text-ink">Mark as caught up</button>
                </form>
              </>
            ) : since.length ? (
              <>
                <div className="text-[22px] font-extrabold">
                  {plural(since.length, 'commit')} · {plural(sinceFiles, 'file')}
                </div>
                <div className="text-[#D5D7DE]">by {[...new Set(since.map((c) => c.commit.author.name))].join(', ')}</div>
                <div className="flex flex-wrap gap-3">
                  <Link href={`/w/${slug}/compare${qs({ from: seen, to: head, b: bq })}`} className="font-bold text-paper hover:text-paper">
                    Show what changed
                  </Link>
                  <form action={markSeen}>
                    <input type="hidden" name="ws" value={slug} />
                    <input type="hidden" name="branch" value={branch} />
                    <button className="cursor-pointer border-0 bg-transparent p-0 font-bold text-header-muted underline">Mark as caught up</button>
                  </form>
                </div>
              </>
            ) : (
              <div className="text-[18px] font-bold">You&rsquo;re caught up.</div>
            )}
          </section>

          {pending.length > 0 && (
            <section className="flex flex-col gap-2">
              <div className="eyebrow">Waiting to join {branch}</div>
              {pending.map((p) => (
                <div key={p.name} className="flex flex-col gap-2 rounded-md border-2 border-dashed border-agent p-3.5">
                  <div>
                    <b>{p.name}</b> <span className="text-muted">· {plural(p.ahead, 'stop')} ahead</span>
                  </div>
                  <Link href={`/w/${slug}/merge${qs({ into: branch, from: p.name })}`} className="btn-agent min-h-10 self-start">
                    Review merge
                  </Link>
                </div>
              ))}
            </section>
          )}

          <section className="flex flex-col gap-2">
            <div className="eyebrow">New line</div>
            <form action={createBranch} className="flex flex-col gap-2">
              <input type="hidden" name="ws" value={slug} />
              <input type="hidden" name="from" value={branch} />
              <input type="hidden" name="back" value={`/w/${slug}${qs({ b: bq })}`} />
              <label className="flex flex-col gap-1">
                <span>
                  Branch off <b>{branch}</b> at {short(head)}
                </span>
                <input name="name" required placeholder={`${user.id}/new-idea`} pattern="[A-Za-z0-9._/\-]+" className="field" />
              </label>
              <button className="btn-line self-start">Create branch</button>
            </form>
          </section>

          <section className="flex items-center gap-2.5 text-muted">
            <Avatar userId={user.id} size={26} />
            Working as {user.name}. Live presence arrives with real-time editing.
          </section>
        </aside>
      </div>
    </>
  );
}
