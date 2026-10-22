import Link from 'next/link';
import { Header } from '@/components/Header';
import { MiniMap } from '@/components/MiniMap';
import { currentUser, registry } from '@/lib/data';
import { plural, relativeTime } from '@/lib/format';
import { createDemo, createWorkspace } from './actions';

export const dynamic = 'force-dynamic';

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await currentUser();
  const { error } = await searchParams;
  const metas = await registry.list();

  const cards = await Promise.all(
    metas.map(async (meta) => {
      const ws = (await registry.get(meta.slug))!;
      const [graph, branches, files] = await Promise.all([ws.repo.graph(), ws.repo.branches(), ws.repo.getTree('main').catch(() => ({}))]);
      const head = branches['main'];
      const seen = meta.lastSeen[user.id]?.['main'];
      const newSince = head && seen && seen !== head ? (await ws.repo.commitsBetween(seen, 'main')).length : 0;
      const latest = graph.nodes.at(-1);
      const authors = [...new Set(graph.nodes.map((n) => n.commit.author.name))];
      return { meta, graph, newSince, files: Object.keys(files).length, latest, authors };
    }),
  );

  return (
    <>
      <Header user={user} returnTo="/" />
      <main className="mx-auto box-border flex w-full max-w-[1360px] flex-col gap-7 px-6 py-10 md:px-10">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-[280px] flex-1">
            <h1 className="m-0 text-[44px] leading-[1.05] font-extrabold tracking-[-0.03em]">Your networks</h1>
            <p className="mt-2 mb-0 text-base text-muted">Each workspace is a network of lines: one per branch of your research.</p>
          </div>
          <form action={createDemo}>
            <button className="btn-line">Load demo workspace</button>
          </form>
        </div>

        {cards.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-5">
            {cards.map(({ meta, graph, newSince, files, latest, authors }) => (
              <Link key={meta.slug} href={`/w/${meta.slug}`} className="card flex flex-col overflow-hidden rounded-lg text-ink no-underline hover:text-ink hover:shadow-[4px_4px_0_#17181C]">
                <div className="border-b-2 border-ink bg-panel px-2 pt-2">
                  <MiniMap graph={graph} />
                </div>
                <div className="flex flex-col gap-1.5 px-5 py-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xl font-extrabold">{meta.name}</span>
                    {newSince > 0 && <span className="rounded-full bg-line-main px-2 text-xs font-bold text-paper">{newSince} new</span>}
                  </div>
                  <div className="text-muted">
                    {plural(graph.lanes.length, 'line')} · {plural(graph.nodes.length, 'stop')} · {plural(files, 'file')} · {authors.join(', ')}
                  </div>
                  {latest && (
                    <div className="text-muted">
                      Last stop {relativeTime(latest.commit.timestamp)}: <span className="text-ink">{latest.commit.message}</span>
                    </div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}

        <section className="card flex flex-col gap-4 p-6">
          <h2 className="m-0 text-xl font-extrabold">{cards.length ? 'New workspace' : 'Start your first workspace'}</h2>
          {!cards.length && (
            <p className="m-0 text-muted">
              Or load the demo: a small sleep study with a paper, a PDF, two imported AI chats, code, a merged branch and an agent branch waiting for review.
            </p>
          )}
          <form action={createWorkspace} className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-[260px] flex-1 flex-col gap-1">
              <span className="font-bold">Name</span>
              <input name="name" required className="field" placeholder="e.g. Thesis: retrieval for science" aria-invalid={error === 'name'} />
            </label>
            <label className="flex min-w-[260px] flex-[2] flex-col gap-1">
              <span className="font-bold">Description <span className="font-normal text-muted">(optional)</span></span>
              <input name="description" className="field" />
            </label>
            <button className="btn-ink">Create workspace</button>
          </form>
        </section>
      </main>
    </>
  );
}
