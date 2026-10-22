import Link from 'next/link';
import { Header } from '@/components/Header';
import { currentUser, getWorkspace } from '@/lib/data';

export const dynamic = 'force-dynamic';

export default async function AskPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws: slug } = await params;
  const [ws, user] = await Promise.all([getWorkspace(slug), currentUser()]);
  return (
    <>
      <Header user={user} returnTo={`/w/${slug}/ask`} workspace={ws.meta} active="ask" />
      <main className="mx-auto box-border flex w-full max-w-[760px] flex-col gap-4 px-6 py-12">
        <span className="sign self-start bg-ink text-paper">COMING NEXT</span>
        <h1 className="m-0 text-[32px] leading-tight font-extrabold tracking-[-0.02em]">Ask your research history</h1>
        <p className="m-0 text-base leading-relaxed">
          Ask a question across every document, chat, PDF and code file, and get an answer with citations to the exact paragraph, turn or commit it
          came from. A time slider answers the question as the workspace stood at any stop.
        </p>
        <p className="m-0 text-muted">This needs search and embeddings, which arrive in phase 5 together with the hosted database.</p>
        <Link href={`/w/${slug}/history`} className="btn-line self-start">
          Browse history meanwhile
        </Link>
      </main>
    </>
  );
}
