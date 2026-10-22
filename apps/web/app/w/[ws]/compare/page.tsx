import Link from 'next/link';
import { ErrorBanner, KindSign } from '@/components/Bits';
import { DiffView } from '@/components/DiffView';
import { Header } from '@/components/Header';
import { currentUser, getWorkspace, param, pickBranch } from '@/lib/data';
import { cleanSummary, plural, qs, short, truncate } from '@/lib/format';
import { fileHref } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const STATUS: Record<string, { label: string; cls: string }> = {
  modified: { label: 'MODIFIED', cls: 'text-line-main' },
  added: { label: 'ADDED', cls: 'text-ins-fg' },
  removed: { label: 'REMOVED', cls: 'text-del-fg' },
  renamed: { label: 'RENAMED', cls: 'text-muted' },
};

export default async function ComparePage({ params, searchParams }: Props) {
  const { ws: slug } = await params;
  const sp = await searchParams;
  const [ws, user] = await Promise.all([getWorkspace(slug), currentUser()]);
  const { branch, branches } = await pickBranch(ws, sp['b']);
  const bq = branch === 'main' ? undefined : branch;
  const graph = await ws.repo.graph();
  const stops = [...graph.nodes].reverse();

  const head = branches[branch]!;
  const seen = ws.meta.lastSeen[user.id]?.[branch];
  const defaultFrom = seen && seen !== head ? seen : (await ws.repo.readCommit(head)).parents[0] ?? head;
  const fromRev = param(sp['from']) ?? defaultFrom;
  const toRev = param(sp['to']) ?? head;
  const path = param(sp['path']);
  const showUnchanged = param(sp['ctx']) === '1';

  let error: string | undefined = param(sp['error']);
  let from = '';
  let to = '';
  try {
    from = await ws.repo.resolve(fromRev);
    to = await ws.repo.resolve(toRev);
  } catch {
    error = 'One of those stops does not exist.';
  }
  const diff = from && to ? await ws.repo.diff(from, to, path ? { paths: [path] } : {}) : null;
  const between = from && to ? await ws.repo.commitsBetween(from, to) : [];

  const option = (h: string) => {
    const n = graph.nodes.find((x) => x.hash === h)!;
    const tags = n.heads.length ? ` [${n.heads.join(', ')}]` : '';
    return `${truncate(n.commit.message, 42)} · ${short(h)} · ${n.commit.author.name}${tags}`;
  };
  const others = Object.keys(branches).filter((b) => b !== branch);

  return (
    <>
      <Header user={user} returnTo={`/w/${slug}/compare${qs({ b: bq, from: fromRev, to: toRev, path })}`} workspace={ws.meta} active="compare" branch={branch} />

      <section aria-label="Choose stops" className="flex flex-col gap-3 border-b-2 border-ink px-6 py-5 md:px-10">
        <form method="get" action={`/w/${slug}/compare`} className="flex flex-wrap items-end gap-x-4 gap-y-3">
          {bq && <input type="hidden" name="b" value={bq} />}
          {path && <input type="hidden" name="path" value={path} />}
          <label className="flex min-w-[260px] flex-1 flex-col gap-1">
            <span className="eyebrow text-xs">From</span>
            <select name="from" defaultValue={from} className="field font-semibold">
              {stops.map((n) => (
                <option key={n.hash} value={n.hash}>
                  {option(n.hash)}
                </option>
              ))}
            </select>
          </label>
          <div aria-hidden className="flex min-h-11 items-center">
            <span className="box-border size-3.5 rounded-full border-[3px] border-ink" />
            <span className="h-1.5 w-16 bg-line-main" />
            <span className="box-border size-[18px] rounded-full border-4 border-paper bg-ink shadow-[0_0_0_2px_#17181C]" />
          </div>
          <label className="flex min-w-[260px] flex-1 flex-col gap-1">
            <span className="eyebrow text-xs">To</span>
            <select name="to" defaultValue={to} className="field font-semibold">
              {stops.map((n) => (
                <option key={n.hash} value={n.hash}>
                  {option(n.hash)}
                </option>
              ))}
            </select>
          </label>
          <button className="btn-ink">Compare</button>
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-bold">Quick:</span>
          {seen && seen !== head && (
            <Link href={`/w/${slug}/compare${qs({ b: bq, from: seen, to: head })}`} className="btn min-h-9 rounded-full bg-ink px-3 text-paper hover:text-paper">
              Since my last visit
            </Link>
          )}
          {others.map((o) => (
            <Link key={o} href={`/w/${slug}/compare${qs({ b: bq, from: branch, to: o })}`} className="btn min-h-9 rounded-full border-2 border-ink px-3 text-ink hover:text-ink">
              {branch} vs {o}
            </Link>
          ))}
          {path && (
            <Link href={`/w/${slug}/compare${qs({ b: bq, from: fromRev, to: toRev })}`} className="btn min-h-9 rounded-full border-2 border-ink px-3 text-ink hover:text-ink">
              All files (now: {path})
            </Link>
          )}
        </div>
      </section>

      <div className="flex flex-wrap">
        <nav aria-label="Changed files" className="flex max-w-[320px] min-w-[240px] flex-1 flex-col gap-1 px-6 py-6 md:pl-10">
          {diff && (
            <div className="eyebrow mb-2">
              {plural(diff.files.length, 'file')} changed · {plural(between.length, 'stop')}
            </div>
          )}
          {diff?.files.map((f) => (
            <a key={f.path} href={`#f-${encodeURIComponent(f.path)}`} className="flex flex-col py-2 text-ink no-underline hover:text-line-main">
              <span className="font-bold break-all">{f.path}</span>
              <span className={`text-xs font-bold ${STATUS[f.status]!.cls}`}>
                {STATUS[f.status]!.label} · {plural(f.diff.stats.modified + f.diff.stats.added + f.diff.stats.removed + f.diff.stats.moved, 'change')}
              </span>
            </a>
          ))}
          {between.length > 0 && (
            <div className="mt-4 flex flex-col gap-1 border-t border-rule pt-3">
              <div className="eyebrow mb-1 text-xs">Stops in between</div>
              {between.slice(0, 12).map((c) => (
                <Link key={c.hash} href={`/w/${slug}/history${qs({ b: bq, sel: c.hash })}`} className="text-ink">
                  {truncate(c.commit.message, 34)} <span className="text-muted">· {c.commit.author.name}</span>
                </Link>
              ))}
            </div>
          )}
        </nav>

        <main className="flex min-w-0 flex-[999_1_560px] flex-col gap-5 py-6 pr-6 pl-6 md:pr-10">
          <ErrorBanner message={error} />
          {diff && diff.files.length === 0 && <p className="m-0 text-muted">These two stops have identical files.</p>}
          {diff && diff.files.length > 0 && (
            <div className="flex justify-end">
              <Link href={`/w/${slug}/compare${qs({ b: bq, from: fromRev, to: toRev, path, ctx: showUnchanged ? undefined : '1' })}`} className="font-semibold">
                {showUnchanged ? 'Hide unchanged parts' : 'Show unchanged parts'}
              </Link>
            </div>
          )}
          {diff?.files.map((f) => (
            <section key={f.path} id={`f-${encodeURIComponent(f.path)}`} className={`overflow-hidden rounded-md border-2 ${f.status === 'added' ? 'border-dashed border-muted' : 'border-ink'}`}>
              <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 bg-ink px-5 py-3 text-paper">
                <KindSign kind={f.diff.kind} inverse />
                <Link href={fileHref(slug, f.path, qs({ b: bq, at: to }))} className="font-bold text-paper hover:text-paper">
                  {f.path}
                </Link>
                {f.oldPath && <span className="text-header-muted">renamed from {f.oldPath}</span>}
                <span className="text-[#D5D7DE]">{f.diff.summary.slice(0, 2).map(cleanSummary).join(' · ')}{f.diff.summary.length > 2 ? ` · +${f.diff.summary.length - 2} more` : ''}</span>
              </div>
              <DiffView diff={f.diff} showUnchanged={showUnchanged} />
            </section>
          ))}
        </main>
      </div>
    </>
  );
}
