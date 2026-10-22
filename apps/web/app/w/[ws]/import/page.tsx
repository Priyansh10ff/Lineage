import { hashObject } from '@lineage/core';
import Link from 'next/link';
import { ErrorBanner } from '@/components/Bits';
import { Header } from '@/components/Header';
import { currentUser, getWorkspace, param, pickBranch, registry } from '@/lib/data';
import { plural, qs } from '@/lib/format';
import { commitImport, stageImport, type StagedImport } from '../actions';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const FORMAT_SIGN: Record<string, string> = {
  chatgpt: 'bg-line-main text-paper',
  claude: 'bg-line-main text-paper',
  'chat-markdown': 'bg-line-main text-paper',
  pdf: 'bg-ink text-paper',
};

function describe(a: StagedImport['result']['artifacts'][number]): string {
  const n = a.doc.units.length;
  switch (a.doc.kind) {
    case 'chat': {
      const edited = a.doc.units.filter((u) => typeof u.meta?.['alternates'] === 'number').length;
      return `${plural(n, 'turn')}${edited ? ` · ${plural(edited, 'edited message')}` : ''}`;
    }
    case 'pdf':
      return `${plural(a.doc.units.filter((u) => u.type !== 'heading').length, 'paragraph')} · ${plural(Number(a.doc.meta?.['pages'] ?? 0), 'page')}`;
    case 'code':
      return a.doc.meta?.['parser'] === 'tree-sitter' ? plural(a.doc.units.filter((u) => u.type === 'symbol').length, 'symbol') : plural(n, 'block');
    default:
      return plural(n, 'block');
  }
}

export default async function ImportPage({ params, searchParams }: Props) {
  const { ws: slug } = await params;
  const sp = await searchParams;
  const [ws, user] = await Promise.all([getWorkspace(slug), currentUser()]);
  const { branch, branches } = await pickBranch(ws, sp['b']);
  const bq = branch === 'main' ? undefined : branch;
  const stagedId = param(sp['staged']);
  const staged = stagedId ? await registry.readStage<StagedImport>(slug, stagedId) : undefined;
  const existing = staged ? await ws.repo.getTree(branch) : {};

  return (
    <>
      <Header user={user} returnTo={`/w/${slug}/import${qs({ b: bq, staged: stagedId })}`} workspace={ws.meta} active="import" branch={branch} />
      <main className="box-border flex w-full max-w-[1200px] flex-col gap-6 px-6 py-7 md:px-10">
        <div>
          <h1 className="m-0 text-[32px] font-extrabold tracking-[-0.02em]">Import</h1>
          <p className="mt-1.5 mb-0 text-[15px] text-muted">
            Markdown, text, PDFs, ChatGPT and Claude exports (the JSON or the whole zip), code files and repo zips.
          </p>
        </div>
        <ErrorBanner message={param(sp['error'])} />

        {!staged ? (
          <form action={stageImport} className="flex flex-col gap-4">
            <input type="hidden" name="ws" value={slug} />
            <input type="hidden" name="branch" value={branch} />
            <label className="flex min-h-[170px] cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-[3px] border-dashed border-ink bg-panel p-6 text-center focus-within:outline focus-within:outline-3 focus-within:outline-line-main">
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="#17181C" strokeWidth="2.2" aria-hidden>
                <path d="M16 22V6M9 13l7-7 7 7M6 26h20" />
              </svg>
              <span className="text-[17px] font-extrabold">Choose files</span>
              <span className="text-muted">Several at once is fine · up to 1 MB per file inside zips</span>
              <input type="file" name="files" multiple required className="mt-2 max-w-full text-sm" />
            </label>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex min-w-[240px] flex-col gap-1">
                <span className="font-bold">
                  Put under folder <span className="font-normal text-muted">(optional)</span>
                </span>
                <input name="prefix" placeholder="e.g. project-a" className="field" />
              </label>
              <button className="btn-ink">Read files</button>
              <span className="pb-3 text-muted">Nothing is committed until you confirm on the next step.</span>
            </div>
          </form>
        ) : (
          <form action={commitImport} className="flex flex-col gap-4">
            <input type="hidden" name="ws" value={slug} />
            <input type="hidden" name="staged" value={stagedId} />
            <div className="flex flex-wrap items-baseline gap-x-3.5">
              <h2 className="m-0 text-xl font-extrabold">Ready to commit</h2>
              <span className="text-muted">
                {plural(staged.uploaded.length, 'upload')} became {plural(staged.result.artifacts.length, 'artifact')}
              </span>
            </div>
            {staged.result.artifacts.length > 0 ? (
              <div className="overflow-x-auto rounded-md border-2 border-ink">
                <table className="w-full min-w-[760px] border-collapse">
                  <thead>
                    <tr className="bg-ink text-left text-paper">
                      <th className="w-12 px-3.5 py-2.5 font-bold"><span className="sr-only">Include</span></th>
                      <th className="px-3.5 py-2.5 font-bold">Type</th>
                      <th className="px-3.5 py-2.5 font-bold">Path in workspace</th>
                      <th className="px-3.5 py-2.5 font-bold">Parsed into</th>
                      <th className="px-3.5 py-2.5 font-bold">From</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staged.result.artifacts.map((a) => (
                      <tr key={a.path} className="border-b border-rule last:border-b-0">
                        <td className="px-3.5 py-2.5">
                          <input type="checkbox" name="keep" value={a.path} defaultChecked aria-label={`Include ${a.path}`} className="size-[18px] accent-ink" />
                        </td>
                        <td className="px-3.5 py-2.5">
                          <span className={`sign ${FORMAT_SIGN[a.format] ?? 'border border-ink'}`}>{a.format.toUpperCase()}</span>
                        </td>
                        <td className="px-3.5 py-2.5 font-mono text-[13px]">
                          {a.path}
                          {a.path in existing &&
                            (existing[a.path] === hashObject({ type: 'blob', doc: a.doc }) ? (
                              <span className="ml-2 font-sans text-xs font-bold text-muted">ALREADY HERE, UNCHANGED</span>
                            ) : (
                              <span className="ml-2 font-sans text-xs font-bold text-line-main">NEW VERSION OF EXISTING</span>
                            ))}
                        </td>
                        <td className="px-3.5 py-2.5">{describe(a)}</td>
                        <td className="px-3.5 py-2.5 text-muted">{a.sourceName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="m-0">Nothing in those files could be imported.</p>
            )}
            {staged.result.warnings.length > 0 && (
              <div className="flex flex-col gap-1 rounded border-l-4 border-[#C46A00] bg-warn-bg px-3.5 py-3">
                <b>{plural(staged.result.warnings.length, 'note')}</b>
                {staged.result.warnings.slice(0, 12).map((w, i) => (
                  <span key={i}>{w}</span>
                ))}
                {staged.result.warnings.length > 12 && <span>and {staged.result.warnings.length - 12} more</span>}
              </div>
            )}
            <div className="flex flex-wrap items-end gap-3.5 border-t-2 border-ink pt-4">
              <label className="flex flex-col gap-1">
                <span className="font-bold">Commit to line</span>
                <select name="branch" defaultValue={branch} className="field font-semibold">
                  {Object.keys(branches).map((b) => (
                    <option key={b}>{b}</option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-[320px] flex-1 flex-col gap-1">
                <span className="font-bold">Message</span>
                <input name="message" defaultValue={`Import ${staged.uploaded.map((u) => u.name).join(', ')}`.slice(0, 120)} className="field" />
              </label>
              <button className="btn-ink" disabled={!staged.result.artifacts.length}>
                Commit {plural(staged.result.artifacts.length, 'artifact')}
              </button>
              <Link href={`/w/${slug}/import${qs({ b: bq })}`} className="btn-line">
                Start over
              </Link>
            </div>
          </form>
        )}
      </main>
    </>
  );
}
