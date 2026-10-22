import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-[640px] flex-col gap-4 px-6 py-20">
      <span className="sign self-start bg-ink text-paper">NO SUCH STOP</span>
      <h1 className="m-0 text-[36px] font-extrabold tracking-[-0.02em]">This line doesn&rsquo;t go there.</h1>
      <p className="m-0 text-muted">The workspace, file or version you asked for doesn&rsquo;t exist.</p>
      <Link href="/" className="btn-ink self-start">
        Back to your networks
      </Link>
    </main>
  );
}
