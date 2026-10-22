import type { Doc, Unit } from '@lineage/core';

function headingText(u: Unit) {
  return u.text.replace(/^#+\s*/, '');
}

function ProseUnit({ u }: { u: Unit }) {
  switch (u.type) {
    case 'heading': {
      const level = Number(u.meta?.['level'] ?? 2);
      return level <= 1 ? (
        <h2 className="m-0 text-[32px] leading-tight font-extrabold tracking-[-0.02em]">{headingText(u)}</h2>
      ) : (
        <h3 className="eyebrow mt-2 mb-0">{headingText(u)}</h3>
      );
    }
    case 'list':
      return <p className="m-0 whitespace-pre-wrap">{u.text}</p>;
    case 'quote':
      return <blockquote className="m-0 border-l-4 border-rule pl-4 whitespace-pre-wrap text-[#3D4048]">{u.text.replace(/^>\s?/gm, '')}</blockquote>;
    case 'code_block':
      return <pre className="m-0 overflow-x-auto rounded bg-ink px-4 py-3 font-mono text-[13px] text-paper">{u.text}</pre>;
    default:
      return <p className="m-0 whitespace-pre-wrap">{u.text}</p>;
  }
}

function ProseView({ doc }: { doc: Doc }) {
  return (
    <article className="flex max-w-[760px] flex-col gap-4 text-[17px] leading-[1.75]">
      {doc.units.map((u, i) => (
        <ProseUnit key={i} u={u} />
      ))}
    </article>
  );
}

/** Chat text with fenced code blocks rendered as code. */
function ChatText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const re = /```([\w+-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<div key={i++} className="whitespace-pre-wrap">{text.slice(last, m.index).trim()}</div>);
    parts.push(
      <pre key={i++} className="m-0 overflow-x-auto rounded bg-ink px-3.5 py-3 font-mono text-[13px] text-paper">
        {m[1] && <span className="mb-1 block text-xs text-header-muted">{m[1]}</span>}
        {m[2]!.replace(/\n$/, '')}
      </pre>,
    );
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(<div key={i++} className="whitespace-pre-wrap">{text.slice(last).trim()}</div>);
  return <div className="flex flex-col gap-2 text-base leading-relaxed">{parts}</div>;
}

const ROLE_SIGN: Record<string, string> = {
  user: 'bg-ink text-paper',
  assistant: 'bg-line-main text-paper',
  tool: 'border border-ink',
  system: 'border border-ink',
};

function ChatView({ doc }: { doc: Doc }) {
  return (
    <ol className="m-0 ml-2 flex max-w-[820px] list-none flex-col border-l-[6px] border-line-main p-0">
      {doc.units.map((u, i) => {
        const role = String(u.meta?.['role'] ?? 'unknown');
        const last = i === doc.units.length - 1;
        const alternates = u.meta?.['alternates'];
        const model = u.meta?.['model'];
        const ts = u.meta?.['timestamp'];
        return (
          <li key={i} className="grid grid-cols-[30px_minmax(0,1fr)] gap-x-[18px] pb-6">
            <span
              aria-hidden
              className={`-ml-[18px] box-border size-[30px] rounded-full border-4 border-ink ${last ? 'bg-ink shadow-[0_0_0_3px_#FAFAF7_inset]' : 'bg-paper'}`}
            />
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`sign ${ROLE_SIGN[role] ?? 'border border-ink'}`}>{role.toUpperCase()}</span>
                {typeof model === 'string' && <span className="font-mono text-xs text-muted">{model}</span>}
                {typeof ts === 'string' && (
                  <span className="font-mono text-xs text-muted">{new Date(ts).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                )}
              </div>
              <ChatText text={u.text} />
              {typeof alternates === 'number' && (
                <div className="self-start rounded bg-warn-bg px-3 py-2 text-sm">
                  <b>{alternates === 1 ? 'Another version' : `${alternates} other versions`} of this message existed</b> (edited or regenerated). Lineage keeps the one you saw last.
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function PdfView({ doc }: { doc: Doc }) {
  let page: number | undefined;
  const out: React.ReactNode[] = [];
  doc.units.forEach((u, i) => {
    const p = typeof u.meta?.['page'] === 'number' ? (u.meta['page'] as number) : undefined;
    if (p !== undefined && p !== page) {
      page = p;
      out.push(
        <div key={`p${p}`} id={`page-${p}`} className="mt-3 flex items-center gap-3">
          <span className="sign bg-ink text-paper">PAGE {p}</span>
          <span className="h-0.5 flex-1 bg-ink" />
        </div>,
      );
    }
    out.push(
      u.type === 'heading' ? (
        <h3 key={i} className="m-0 text-[20px] font-extrabold">{u.text}</h3>
      ) : (
        <p key={i} className={`m-0 whitespace-pre-wrap ${u.type === 'list' ? 'rounded border border-rule px-3.5 py-2.5' : ''}`}>
          {u.text}
        </p>
      ),
    );
  });
  return <article className="flex max-w-[820px] flex-col gap-3.5 text-base leading-[1.7]">{out}</article>;
}

function CodeView({ doc }: { doc: Doc }) {
  let line = 1;
  return (
    <div className="flex flex-col gap-3">
      {doc.units.map((u, i) => {
        const lines = u.text.replace(/\n$/, '').split('\n');
        const start = line;
        line += u.text.split('\n').length - 1;
        const kind = u.type === 'symbol' ? String(u.meta?.['symbolKind'] ?? 'symbol') : 'code';
        const name = u.type === 'symbol' ? String(u.meta?.['name'] ?? '') : '';
        return (
          <section key={i} id={name ? `sym-${name}` : undefined} className="overflow-hidden rounded-md border border-rule">
            <div className="flex items-center gap-3 border-b border-rule bg-panel px-3.5 py-2">
              <span className={`sign ${u.type === 'symbol' ? 'bg-line-main text-paper' : 'border border-ink'}`}>{kind.toUpperCase()}</span>
              {name && <b className="font-mono">{name}</b>}
            </div>
            <pre className="m-0 overflow-x-auto bg-white py-2 font-mono text-[13px] leading-[1.7]">
              {lines.map((l, j) => (
                <span key={j} className="block px-4">
                  <span className="inline-block w-10 text-[#8A8D96] select-none">{start + j}</span>
                  {l}
                </span>
              ))}
            </pre>
          </section>
        );
      })}
    </div>
  );
}

export function DocView({ doc }: { doc: Doc }) {
  switch (doc.kind) {
    case 'chat':
      return <ChatView doc={doc} />;
    case 'pdf':
      return <PdfView doc={doc} />;
    case 'code':
      return <CodeView doc={doc} />;
    default:
      return <ProseView doc={doc} />;
  }
}

/** Outline entries for the side panel: headings, PDF pages, or code symbols. */
export function outline(doc: Doc): { label: string; anchor?: string; kind?: string }[] {
  if (doc.kind === 'code') {
    return doc.units
      .filter((u) => u.type === 'symbol')
      .map((u) => ({ label: String(u.meta?.['name'] ?? ''), anchor: `sym-${String(u.meta?.['name'] ?? '')}`, kind: String(u.meta?.['symbolKind'] ?? '') }));
  }
  if (doc.kind === 'chat') return [];
  return doc.units
    .filter((u) => u.type === 'heading')
    .map((u) => ({ label: headingText(u), anchor: typeof u.meta?.['page'] === 'number' ? `page-${u.meta['page']}` : undefined, kind: typeof u.meta?.['page'] === 'number' ? `p.${u.meta['page']}` : undefined }));
}
