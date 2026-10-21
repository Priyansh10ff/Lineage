import type { Doc, Meta, Unit } from '@lineage/core';
import { extractTextItems, getDocumentProxy, getMeta } from 'unpdf';

interface Item {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  hasEOL: boolean;
}

interface Line {
  text: string;
  y: number;
  x: number;
  fontSize: number;
  page: number;
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Group positioned text items into visual lines. */
function toLines(items: Item[], page: number): Line[] {
  const lines: Line[] = [];
  let cur: { parts: string[]; y: number; x: number; fontSize: number; endX: number } | null = null;
  let breakNext = false;
  const push = () => {
    if (cur) {
      const text = cur.parts.join('').replace(/\s+/g, ' ').trim();
      if (text) lines.push({ text, y: cur.y, x: cur.x, fontSize: cur.fontSize, page });
    }
    cur = null;
  };
  for (const it of items) {
    if (!it.str && !it.hasEOL) continue;
    const size = it.fontSize || 10;
    if (cur && (breakNext || Math.abs(it.y - cur.y) > size * 0.5)) push();
    breakNext = false;
    if (it.str) {
      if (!cur) cur = { parts: [], y: it.y, x: it.x, fontSize: size, endX: it.x };
      else {
        const gap = it.x - cur.endX;
        const prev = cur.parts[cur.parts.length - 1] ?? '';
        if (gap > size * 0.15 && !/\s$/.test(prev) && !/^\s/.test(it.str)) cur.parts.push(' ');
      }
      cur.parts.push(it.str);
      cur.fontSize = Math.max(cur.fontSize, it.str.trim() ? size : 0);
      cur.endX = it.x + it.width;
    }
    if (it.hasEOL) breakNext = true;
  }
  push();
  return lines;
}

const digitsMasked = (s: string) => s.replace(/\d+/g, '#').toLowerCase();
const PAGE_NUMBER = /^(page\s*)?[#\divxlc]+(\s*(of|\/)\s*\d+)?$/i;

/** Drop running headers/footers (same text near the top or bottom of most pages) and bare page numbers. */
function stripFurniture(pages: Line[][]): Line[][] {
  const counts = new Map<string, number>();
  for (const lines of pages) {
    const edge = new Set([...lines.slice(0, 2), ...lines.slice(-2)].map((l) => digitsMasked(l.text)));
    for (const k of edge) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 0.5));
  return pages.map((lines) =>
    lines.filter((l, i) => {
      const atEdge = i < 2 || i >= lines.length - 2;
      if (atEdge && PAGE_NUMBER.test(l.text.trim())) return false;
      return !(atEdge && pages.length > 1 && (counts.get(digitsMasked(l.text)) ?? 0) >= threshold);
    }),
  );
}

const SECTION_WORDS =
  /^(abstract|introduction|background|related work|methods?|methodology|materials and methods|experiments?|results|discussion|conclusions?|limitations|future work|references|bibliography|acknowledge?ments|appendix)\b/i;

function isHeadingLine(l: Line, bodySize: number): boolean {
  const t = l.text;
  if (t.length > 120 || /[.,;]$/.test(t)) return false;
  if (l.fontSize >= bodySize * 1.15) return true;
  if (t.length > 80) return false;
  if (/^(\d+(\.\d+)*\.?|[IVX]+\.)\s+\p{Lu}/u.test(t) && t.split(/\s+/).length <= 10) return true;
  if (SECTION_WORDS.test(t) && t.split(/\s+/).length <= 6) return true;
  return /^[\p{Lu}\d\s:&-]{4,}$/u.test(t) && /\p{Lu}{3}/u.test(t);
}

/** Join two lines of the same paragraph, undoing end-of-line hyphenation. */
function joinLines(a: string, b: string): string {
  if (/\p{Ll}-$/u.test(a) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b;
  return `${a} ${b}`;
}

const BULLET = /^([•▪◦‣●○■□·∙–—*-]|\(?([a-z]|\d{1,3}|[ivx]{1,4})[.)])\s+/u;
const ENDS_SENTENCE = /[.!?:"”')\]]$/;

/** Rebuild headings and paragraphs from lines using font size and vertical spacing. */
export function linesToUnits(pages: Line[][]): { units: Unit[]; title?: string } {
  const all = pages.flat();
  if (!all.length) return { units: [] };

  // Body font size: the size covering the most characters.
  const bySize = new Map<number, number>();
  for (const l of all) {
    const k = Math.round(l.fontSize * 2) / 2;
    bySize.set(k, (bySize.get(k) ?? 0) + l.text.length);
  }
  const bodySize = [...bySize].sort((a, b) => b[1] - a[1])[0]![0];

  const gaps: number[] = [];
  for (const lines of pages) {
    for (let i = 1; i < lines.length; i++) {
      const dy = lines[i - 1]!.y - lines[i]!.y;
      const bothBody = Math.abs(lines[i]!.fontSize - bodySize) < 0.6 && Math.abs(lines[i - 1]!.fontSize - bodySize) < 0.6;
      if (dy > 0 && bothBody && !isHeadingLine(lines[i - 1]!, bodySize)) gaps.push(dy);
    }
  }
  const lineGap = median(gaps) || bodySize * 1.2;

  const units: Unit[] = [];
  let para: { text: string; page: number; list: boolean } | null = null;
  let heading: { text: string; page: number; size: number } | null = null;

  const flushPara = () => {
    if (para) units.push({ type: para.list ? 'list' : 'paragraph', text: para.text, meta: { page: para.page } });
    para = null;
  };
  let title: string | undefined;
  const flushHeading = () => {
    if (heading && !title && heading.page === 1 && heading.size >= bodySize * 1.3) title = heading.text;
    if (heading) units.push({ type: 'heading', text: heading.text, meta: { page: heading.page, level: 2 } });
    heading = null;
  };

  for (let p = 0; p < pages.length; p++) {
    const lines = pages[p]!;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      const prev = lines[i - 1];

      if (isHeadingLine(l, bodySize)) {
        flushPara();
        // Multi-line headings: consecutive heading lines of the same size.
        if (heading && Math.abs(heading.size - l.fontSize) < 0.6 && prev && prev.y - l.y < l.fontSize * 2) {
          heading.text += ` ${l.text}`;
        } else {
          flushHeading();
          heading = { text: l.text, page: l.page, size: l.fontSize };
        }
        continue;
      }
      flushHeading();

      const dy = prev ? prev.y - l.y : Infinity;
      const newPara =
        !para ||
        (i === 0
          ? // Continue a paragraph across a page break only if it clearly didn't end.
            ENDS_SENTENCE.test(para.text) || !/^\p{Ll}/u.test(l.text)
          : dy > lineGap * 1.35 || dy < 0 || Math.abs((prev?.fontSize ?? 0) - l.fontSize) > 0.6);
      const bullet = BULLET.test(l.text);
      if (bullet && para?.list && !newPara) {
        para.text += `\n${l.text}`; // next item of the same list
      } else if (bullet || newPara) {
        flushPara();
        para = { text: l.text, page: l.page, list: bullet };
      } else {
        para!.text = joinLines(para!.text, l.text); // wrapped line (also continues a list item)
      }
    }
  }
  flushPara();
  if (heading) flushHeading();

  const out: { units: Unit[]; title?: string } = { units };
  if (title) out.title = title;
  return out;
}

export interface PdfResult {
  doc: Doc;
  pages: number;
  /** True when no text could be extracted, typically a scanned PDF (OCR is out of scope). */
  empty: boolean;
}

export async function parsePdf(data: Uint8Array, fallbackTitle?: string): Promise<PdfResult> {
  // pdf.js may detach the buffer it's given; keep the caller's copy intact.
  const pdf = await getDocumentProxy(new Uint8Array(data));
  try {
    const { totalPages, items } = await extractTextItems(pdf);
    const pages = stripFurniture(items.map((pageItems, i) => toLines(pageItems as Item[], i + 1)));
    const { units, title: detected } = linesToUnits(pages);

    let infoTitle: string | undefined;
    const meta: Meta = { source: 'pdf', pages: totalPages };
    try {
      const { info } = await getMeta(pdf);
      const rec = (info ?? {}) as Record<string, unknown>;
      if (typeof rec['Title'] === 'string' && rec['Title'].trim()) infoTitle = rec['Title'].trim();
      if (typeof rec['Author'] === 'string' && rec['Author'].trim()) meta['author'] = rec['Author'].trim();
    } catch {
      // Metadata is optional.
    }
    const doc: Doc = { kind: 'pdf', units, meta };
    const title = infoTitle ?? detected ?? fallbackTitle;
    if (title) doc.title = title;
    return { doc, pages: totalPages, empty: units.length === 0 };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
