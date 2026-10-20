import type { Doc, Unit } from './types.js';

/**
 * Parse Markdown / plain text into block-level units: headings, paragraphs, lists,
 * quotes and fenced code blocks. Blocks are what humans think of as "a paragraph",
 * so they're the right granularity for diff and merge.
 */
export function parseProse(text: string, title?: string): Doc {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const units: Unit[] = [];
  let buf: string[] = [];
  let bufType: Unit['type'] | null = null;

  const flush = () => {
    if (bufType && buf.length) {
      const body = buf.join('\n').trim();
      if (body) units.push({ type: bufType, text: body });
    }
    buf = [];
    bufType = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const marker = fence[1]!;
      const block = [line];
      i++;
      while (i < lines.length) {
        block.push(lines[i]!);
        if (lines[i]!.trimStart().startsWith(marker)) break;
        i++;
      }
      units.push({ type: 'code_block', text: block.join('\n') });
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      units.push({ type: 'heading', text: line.trim(), meta: { level: heading[1]!.length } });
      continue;
    }

    const isList = /^\s*([-*+]|\d+[.)])\s+/.test(line);
    const isQuote = /^\s*>/.test(line);
    const type: Unit['type'] = isList ? 'list' : isQuote ? 'quote' : 'paragraph';

    // List continuation lines (indented) stay in the list block.
    if (bufType === 'list' && !isList && /^\s+\S/.test(line)) {
      buf.push(line);
      continue;
    }
    if (bufType && bufType !== type) flush();
    bufType = type;
    buf.push(line);
  }
  flush();

  const doc: Doc = { kind: 'prose', units };
  const firstHeading = units.find((u) => u.type === 'heading');
  const resolvedTitle = title ?? firstHeading?.text.replace(/^#+\s*/, '');
  if (resolvedTitle) doc.title = resolvedTitle;
  return doc;
}

/** Render a doc back to Markdown-ish text. `parseProse(renderDoc(d))` round-trips prose docs. */
export function renderDoc(doc: Doc): string {
  return doc.units
    .map((u) => {
      if (u.type === 'turn') return `**${String(u.meta?.['role'] ?? 'unknown')}:** ${u.text}`;
      return u.text;
    })
    .join('\n\n');
}
