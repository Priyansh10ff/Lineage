import type { ConflictedFile, MergeRegion, Unit } from '@lineage/core';
import Link from 'next/link';
import { ErrorBanner } from '@/components/Bits';
import { DiffView } from '@/components/DiffView';
import { Header } from '@/components/Header';
import { currentUser, getWorkspace, param } from '@/lib/data';
import { plural, qs, relativeTime, short } from '@/lib/format';
import { isAgentBranch } from '@/lib/lanes';
import { unmergedLines } from '@/lib/workspace';
import { completeMergeAction, deleteBranchAction, fastForwardAction } from '../actions';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

function UnitsText({ units, empty }: { units: Unit[]; empty: string }) {
  if (!units.length) return <p className="m-0 text-muted italic">{empty}</p>;
  return (
    <div className="flex flex-col gap-2">
      {units.map((u, i) => (
        <p key={i} className="m-0 text-[15px] leading-relaxed whitespace-pre-wrap">
          {u.type === 'turn' && <b className="mr-1">{String(u.meta?.['role'] ?? '')}:</b>}
          {u.text}
        </p>
      ))}
    </div>
  );
}

function ConflictRegion({
  path,
  file,
  region,
  index,
  total,
  into,
  from,
}: {
  path: string;
  file: ConflictedFile;
  region: Extract<MergeRegion, { type: 'conflict' }>;
  index: number;
  total: number;
  into: string;
  from: string;
}) {
  const key = `${path}::${region.id}`;
  const del = file.reason === 'delete-modify';
  const choices: { value: string; label: string }[] = del
    ? [
        { value: file.deletedBy === 'ours' ? 'ours' : 'theirs', label: 'Delete the file' },
        { value: file.deletedBy === 'ours' ? 'theirs' : 'ours', label: `Keep ${file.deletedBy === 'ours' ? from : into}'s edited version` },
      ]
    : [
        { value: 'ours', label: `Keep ${into}` },
        { value: 'theirs', label: `Keep ${from}` },
        { value: 'ours-then-theirs', label: 'Keep both' },
        { value: 'custom', label: 'Write my own' },
      ];
  const customDefault = (region.ours.length ? region.ours : region.theirs).map((u) => u.text).join('\n\n');
  return (
    <fieldset className="m-0 flex flex-col gap-3 rounded-md border-2 border-ink p-4">
      <legend className="px-1.5 font-extrabold">
        {path} · conflict {index} of {total}
        {file.reason === 'add-add' && ' · both lines created this file'}
        {del && ` · ${file.deletedBy === 'ours' ? into : from} deleted it, the other line edited it`}
      </legend>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="flex flex-col gap-2 rounded-md border border-rule bg-panel p-3.5">
          <span className="text-xs font-extrabold tracking-[0.06em] text-muted">BEFORE BOTH</span>
          <UnitsText units={region.base} empty="(didn't exist)" />
        </div>
        <div className="flex flex-col gap-2 rounded-md border-2 border-line-main p-3.5">
          <span className="text-xs font-extrabold tracking-[0.06em] text-line-main">{into.toUpperCase()}</span>
          <UnitsText units={region.ours} empty="(removed)" />
        </div>
        <div className={`flex flex-col gap-2 rounded-md border-2 p-3.5 ${isAgentBranch(from) ? 'border-agent' : 'border-[#9C5A12]'}`}>
          <span className={`text-xs font-extrabold tracking-[0.06em] ${isAgentBranch(from) ? 'text-agent' : 'text-[#7A4510]'}`}>{from.toUpperCase()}</span>
          <UnitsText units={region.theirs} empty="(removed)" />
        </div>
      </div>
      <div role="radiogroup" aria-label="Resolution" className="flex flex-wrap gap-2">
        {choices.map((c, i) => (
          <label key={c.value} className="flex min-h-11 cursor-pointer items-center gap-2 rounded border-2 border-ink px-3.5 font-bold has-[:checked]:bg-line-main-tint">
            <input type="radio" name={`choice:${key}`} value={c.value} defaultChecked={i === 0} className="size-[18px] accent-line-main" />
            {c.label}
          </label>
        ))}
      </div>
      {!del && (
        <details>
          <summary className="cursor-pointer font-semibold">Text for &ldquo;Write my own&rdquo;</summary>
          <textarea name={`custom:${key}`} rows={4} defaultValue={customDefault} className="field mt-2 w-full py-2 text-[15px]" aria-label="Your version" />
        </details>
      )}
    </fieldset>
  );
}

export default async function MergePage({ params, searchParams }: Props) {
  const { ws: slug } = await params;
  const sp = await searchParams;
  const [ws, user] = await Promise.all([getWorkspace(slug), currentUser()]);
  const branches = await ws.repo.branches();
  const names = Object.keys(branches);
  const into = param(sp['into']) ?? 'main';
  const from = param(sp['from']);
  const error = param(sp['error']);

  // Lines with work main doesn't have yet.
  const waiting = 'main' in branches ? (await unmergedLines(ws, 'main')).map((u) => ({ into: 'main', ...u })) : [];

  const preview = from && from in branches && into in branches && from !== into ? await ws.repo.previewMerge({ into, from }) : null;
  const draft = preview?.status === 'ready' ? preview.draft : null;
  const conflictFiles = draft ? Object.entries(draft.conflicts) : [];
  const total = conflictFiles.reduce((n, [, f]) => n + f.regions.filter((r) => r.type === 'conflict').length, 0);
  const incoming = draft ? await ws.repo.diff(draft.base, draft.theirsHead) : null;
  const fromLog = from && from in branches ? await ws.repo.commitsBetween(into, from) : [];
  const tip = fromLog[0];

  return (
    <>
      <Header user={user} returnTo={`/w/${slug}/merge${qs({ into, from })}`} workspace={ws.meta} active="merge" />

      <section className="flex flex-wrap items-end gap-x-10 gap-y-4 border-b-2 border-ink px-6 py-5 md:px-10">
        <div className="flex min-w-[320px] flex-1 flex-col gap-1.5">
          <div className={`eyebrow text-xs ${from && isAgentBranch(from) ? 'text-agent' : ''}`}>Merge</div>
          <h1 className="m-0 text-[30px] leading-tight font-extrabold tracking-[-0.02em]">{from ? `${from} → ${into}` : 'Merges'}</h1>
          {tip && (
            <div className="text-[#3D4048]">
              &ldquo;{tip.commit.message}&rdquo; · {plural(fromLog.length, 'stop')} by {[...new Set(fromLog.map((c) => c.commit.author.name))].join(', ')} · latest {relativeTime(tip.commit.timestamp)}
              {from && isAgentBranch(from) && ' · opened by an agent, needs a human to approve'}
            </div>
          )}
        </div>
        <form method="get" action={`/w/${slug}/merge`} className="flex flex-wrap items-end gap-2.5">
          <label className="flex flex-col gap-1">
            <span className="font-bold">Bring in</span>
            <select name="from" defaultValue={from ?? ''} className="field font-semibold">
              <option value="" disabled>
                choose a line
              </option>
              {names.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-bold">into</span>
            <select name="into" defaultValue={into} className="field font-semibold">
              {names.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <button className="btn-ink">Preview</button>
        </form>
      </section>

      <main className="flex flex-col gap-5 px-6 py-6 md:px-10">
        <ErrorBanner message={error} />

        {!from && (
          <section className="flex max-w-[760px] flex-col gap-3">
            <h2 className="m-0 text-xl font-extrabold">Waiting to merge</h2>
            {waiting.length === 0 && <p className="m-0 text-muted">Every line is merged. Nothing is waiting.</p>}
            {waiting.map((w) => (
              <Link key={`${w.name}>${w.into}`} href={`/w/${slug}/merge${qs({ into: w.into, from: w.name })}`} className={`flex items-center gap-3 rounded-md border-2 p-3.5 text-ink no-underline hover:text-ink ${isAgentBranch(w.name) ? 'border-dashed border-agent' : 'border-ink'}`}>
                <b>{w.name}</b> → {w.into}
                <span className="text-muted">· {plural(w.ahead, 'stop')} ahead</span>
                <span className="ml-auto font-bold text-line-main">Review</span>
              </Link>
            ))}
          </section>
        )}

        {from && from === into && <p className="m-0">Pick two different lines.</p>}
        {preview?.status === 'up-to-date' && (
          <div className="flex flex-wrap items-center gap-4">
            <p className="m-0 text-lg">
              <b>{into}</b> already has everything from <b>{from}</b>.
            </p>
            {from !== 'main' && (
              <form action={deleteBranchAction}>
                <input type="hidden" name="ws" value={slug} />
                <input type="hidden" name="name" value={from} />
                <button className="btn-line">Delete {from}</button>
              </form>
            )}
          </div>
        )}

        {draft && (
          <div className="flex flex-wrap gap-6">
            <nav aria-label="Files in this merge" className="flex max-w-[300px] min-w-[240px] flex-1 flex-col gap-2">
              <div className="eyebrow">Files</div>
              {conflictFiles.map(([p, f]) => (
                <div key={p} className="flex flex-col border-l-4 border-[#C46A00] bg-warn-bg px-3 py-2">
                  <b className="break-all">{p}</b>
                  <span className="text-xs font-bold text-warn-fg">{plural(f.regions.filter((r) => r.type === 'conflict').length, 'CONFLICT')}</span>
                </div>
              ))}
              {draft.autoMerged.map((p) => (
                <div key={p} className="flex flex-col px-3 py-2">
                  <b className="break-all">{p}</b>
                  <span className="text-xs font-bold text-agent">MERGED AUTOMATICALLY</span>
                  <span className="text-xs text-muted">both lines edited it, in different places</span>
                </div>
              ))}
              {incoming?.files
                .filter((f) => !draft.conflicts[f.path] && !draft.autoMerged.includes(f.path))
                .map((f) => (
                  <div key={f.path} className="flex flex-col px-3 py-2">
                    <b className="break-all">{f.path}</b>
                    <span className="text-xs font-bold text-muted">{f.status.toUpperCase()} ON {from?.toUpperCase()} ONLY</span>
                  </div>
                ))}
              <p className="mt-2 mb-0 text-xs text-muted">
                Base {draft.base ? short(draft.base) : '(none)'} · {into} {short(draft.oursHead)} · {from} {short(draft.theirsHead)}
              </p>
            </nav>

            <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-5">
              {preview?.status === 'ready' && preview.canFastForward && (
                <div className="flex flex-wrap items-center gap-3 rounded-md bg-line-main-tint p-4">
                  <span>
                    <b>{into}</b> hasn&rsquo;t moved since {from} branched off, so it can simply jump forward.
                  </span>
                  <form action={fastForwardAction}>
                    <input type="hidden" name="ws" value={slug} />
                    <input type="hidden" name="into" value={into} />
                    <input type="hidden" name="from" value={from} />
                    <button className="btn-ink">Fast-forward {into}</button>
                  </form>
                  <span className="text-muted">or create a merge stop below</span>
                </div>
              )}

              <form action={completeMergeAction} className="flex flex-col gap-5">
                <input type="hidden" name="ws" value={slug} />
                <input type="hidden" name="into" value={into} />
                <input type="hidden" name="from" value={from} />
                <input type="hidden" name="oursHead" value={draft.oursHead} />
                <input type="hidden" name="theirsHead" value={draft.theirsHead} />

                {total > 0 ? (
                  <>
                    <h2 className="m-0 text-[22px] font-extrabold">
                      {plural(total, 'conflict')} to resolve: both lines changed the same text
                    </h2>
                    {conflictFiles.flatMap(([p, f]) => {
                      const regions = f.regions.filter((r): r is Extract<MergeRegion, { type: 'conflict' }> => r.type === 'conflict');
                      return regions.map((r, i) => (
                        <ConflictRegion key={`${p}${r.id}`} path={p} file={f} region={r} index={i + 1} total={regions.length} into={into} from={from!} />
                      ));
                    })}
                  </>
                ) : (
                  <>
                    <h2 className="m-0 text-[22px] font-extrabold">No conflicts. Here&rsquo;s what {from} brings in:</h2>
                    {incoming?.files.map((f) => (
                      <section key={f.path} className="card overflow-hidden">
                        <div className="border-b border-rule bg-panel px-5 py-2.5 font-bold">{f.path}</div>
                        <DiffView diff={f.diff} />
                      </section>
                    ))}
                  </>
                )}

                <div className="flex flex-wrap items-end gap-3 border-t-2 border-ink pt-4">
                  <label className="flex min-w-[320px] flex-1 flex-col gap-1">
                    <span className="font-bold">Merge message</span>
                    <input name="message" defaultValue={`Merge ${from} into ${into}`} className="field" />
                  </label>
                  <button className="btn-agent min-h-12 px-5 font-extrabold">Complete merge</button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
