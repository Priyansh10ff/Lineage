import type { DocDiff, SegmentChange, Unit, UnitChange } from '@lineage/core';

const SIGN: Record<UnitChange['op'], { label: string; className: string }> = {
  equal: { label: 'SAME', className: 'border border-rule text-muted' },
  added: { label: 'ADD', className: 'bg-ins-fg text-paper' },
  removed: { label: 'REMOVE', className: 'bg-del-fg text-paper' },
  modified: { label: 'EDIT', className: 'bg-line-main text-paper' },
  moved: { label: 'MOVE', className: 'bg-ink text-paper' },
};

function isCode(u: Unit) {
  return u.type === 'code_block' || u.type === 'symbol' || u.type === 'line';
}

function unitTitle(u: Unit, section?: string): string {
  if (u.type === 'turn') return `${String(u.meta?.['role'] ?? 'turn')} turn`;
  if (u.type === 'symbol') {
    const kind = String(u.meta?.['symbolKind'] ?? 'symbol');
    const name = String(u.meta?.['name'] ?? '');
    return name && name !== kind ? `${kind} ${name}` : kind;
  }
  const page = u.meta?.['page'];
  return [section, typeof page === 'number' ? `p.${page}` : undefined, u.type === 'heading' ? 'heading' : undefined]
    .filter(Boolean)
    .join(' · ') || u.type;
}

function Segments({ segments, code }: { segments: SegmentChange[]; code: boolean }) {
  if (code) {
    return (
      <pre className="overflow-x-auto rounded border border-rule bg-white py-2 font-mono text-[13px] leading-relaxed">
        {segments.map((s, i) => {
          if (s.op === 'equal') return <span key={i} className="block px-4 text-muted">{`  ${s.text.replace(/\n$/, '')}`}</span>;
          if (s.op === 'added') return <span key={i} className="block bg-ins-bg px-4 text-ins-fg">{`+ ${s.text.replace(/\n$/, '')}`}</span>;
          if (s.op === 'removed') return <span key={i} className="block bg-del-bg px-4 text-del-fg">{`− ${s.text.replace(/\n$/, '')}`}</span>;
          return (
            <span key={i}>
              <span className="block bg-del-bg px-4 text-del-fg">{`− ${s.before.replace(/\n$/, '')}`}</span>
              <span className="block bg-ins-bg px-4 text-ins-fg">{`+ ${s.after.replace(/\n$/, '')}`}</span>
            </span>
          );
        })}
      </pre>
    );
  }
  return (
    <div className="grid grid-cols-[18px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-base leading-relaxed">
      {segments.map((s, i) => {
        switch (s.op) {
          case 'equal':
            return [<span key={`${i}a`} className="text-muted" aria-label="unchanged">=</span>, <span key={i} className="text-muted">{s.text}</span>];
          case 'added':
            return [<span key={`${i}a`} className="font-extrabold text-ins-fg" aria-label="added">+</span>, <span key={i}><ins className="diff">{s.text}</ins></span>];
          case 'removed':
            return [<span key={`${i}a`} className="font-extrabold text-del-fg" aria-label="removed">−</span>, <span key={i}><del className="diff">{s.text}</del></span>];
          case 'modified':
            return [
              <span key={`${i}a`} className="font-extrabold text-line-main" aria-label="changed">~</span>,
              <span key={i}>
                {s.words.map((w, j) =>
                  w.op === 'equal' ? <span key={j}>{w.text}</span> : w.op === 'added' ? <ins key={j} className="diff">{w.text}</ins> : <del key={j} className="diff">{w.text}</del>,
                )}
              </span>,
            ];
        }
      })}
    </div>
  );
}

function ChangeBody({ c }: { c: UnitChange }) {
  switch (c.op) {
    case 'equal':
      return <p className="m-0 whitespace-pre-wrap text-muted">{c.unit.text}</p>;
    case 'added':
      return isCode(c.unit) ? (
        <pre className="overflow-x-auto rounded bg-ins-bg px-4 py-2 font-mono text-[13px] text-ins-fg">{c.unit.text}</pre>
      ) : (
        <p className="m-0 whitespace-pre-wrap text-base leading-relaxed"><ins className="diff">{c.unit.text}</ins></p>
      );
    case 'removed':
      return isCode(c.unit) ? (
        <pre className="overflow-x-auto rounded bg-del-bg px-4 py-2 font-mono text-[13px] text-del-fg">{c.unit.text}</pre>
      ) : (
        <p className="m-0 whitespace-pre-wrap text-base leading-relaxed"><del className="diff">{c.unit.text}</del></p>
      );
    case 'modified':
    case 'moved':
      if (!c.segments.length) return <p className="m-0 whitespace-pre-wrap text-base leading-relaxed text-[#3D4048]">{c.after.text}</p>;
      return <Segments segments={c.segments} code={isCode(c.after)} />;
  }
}

function describe(c: UnitChange): string {
  switch (c.op) {
    case 'moved':
      return `position ${c.oldIndex + 1} → ${c.newIndex + 1}${c.similarity < 1 ? ', also edited' : ', text unchanged'}`;
    case 'modified':
      return c.similarity < 0.6 ? 'rewritten' : 'edited';
    default:
      return '';
  }
}

/** One file's semantic diff: a sign per changed unit, sentence/word marks inside edits. */
export function DiffView({ diff, showUnchanged = false }: { diff: DocDiff; showUnchanged?: boolean }) {
  const changes = showUnchanged ? diff.changes : diff.changes.filter((c) => c.op !== 'equal');
  if (!changes.length) return <p className="px-5 py-4 text-muted">No content changes.</p>;
  return (
    <ol className="m-0 list-none p-0">
      {changes.map((c, i) => {
        const unit = c.op === 'modified' || c.op === 'moved' ? c.after : c.unit;
        const section = 'section' in c ? c.section : undefined;
        const sign = SIGN[c.op];
        return (
          <li key={i} className={`grid grid-cols-[76px_minmax(0,1fr)] gap-4 border-t border-rule px-5 py-4 first:border-t-0 ${c.op === 'equal' ? 'opacity-70' : ''}`}>
            <span className={`sign self-start ${sign.className}`}>{sign.label}</span>
            <div className="flex min-w-0 flex-col gap-2">
              <div className="font-bold">
                {unitTitle(unit, section)}
                {describe(c) && <span className="font-normal text-muted">{` · ${describe(c)}`}</span>}
              </div>
              <ChangeBody c={c} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
