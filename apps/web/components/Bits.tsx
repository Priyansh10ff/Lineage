import Link from 'next/link';

export function ErrorBanner({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded border-l-4 border-[#C46A00] bg-warn-bg px-4 py-3 font-semibold text-warn-fg">
      {message}
    </div>
  );
}

export function KindSign({ kind, inverse }: { kind: string; inverse?: boolean }) {
  const label = kind === 'prose' ? 'DOC' : kind.toUpperCase();
  return <span className={`sign border ${inverse ? 'border-paper text-paper' : 'border-ink'}`}>{label}</span>;
}

export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-muted">
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden>/</span>}
          {it.href ? (
            <Link href={it.href} className="text-muted no-underline hover:text-ink">
              {it.label}
            </Link>
          ) : (
            <span>{it.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function BranchPicker({ branches, current, action, hidden }: { branches: string[]; current: string; action: string; hidden?: Record<string, string> }) {
  return (
    <form action={action} method="get" className="flex items-center gap-2">
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <label htmlFor="branch-pick" className="font-bold">
        Line
      </label>
      <select id="branch-pick" name="b" defaultValue={current} className="field min-h-10 py-1 font-semibold">
        {branches.map((b) => (
          <option key={b}>{b}</option>
        ))}
      </select>
      <button className="btn-line min-h-10">Show</button>
    </form>
  );
}
