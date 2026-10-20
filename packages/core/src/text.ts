import type { Unit } from './types.js';

/** Collapse whitespace so reflowed text compares equal. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Identity of a unit for alignment and merge: type + role-ish meta + normalized text. */
export function unitKey(unit: Unit): string {
  const role = unit.meta?.['role'];
  const name = unit.meta?.['name'];
  const tag = [unit.type, role ?? '', name ?? ''].join('|');
  return `${tag}\u0001${normalizeText(unit.text)}`;
}

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('en', { granularity: 'sentence' })
    : undefined;

/** Split text into sentences, keeping trailing whitespace attached so joining restores the original. */
export function splitSentences(text: string): string[] {
  if (!text) return [];
  let parts: string[];
  if (segmenter) {
    parts = Array.from(segmenter.segment(text), (s) => s.segment);
  } else {
    parts = text.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) ?? [text];
  }
  // Intl splits after newlines too; merge fragments that are only whitespace into the previous sentence.
  const out: string[] = [];
  for (const p of parts) {
    if (out.length && !p.trim()) out[out.length - 1] += p;
    else out.push(p);
  }
  return out;
}

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

/**
 * Sørensen–Dice similarity in [0, 1] over word multisets, falling back to character
 * bigrams for very short strings where word overlap is too coarse.
 */
export function similarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;
  let ta = tokens(na);
  let tb = tokens(nb);
  if (ta.length < 4 || tb.length < 4) {
    ta = bigrams(na.toLowerCase());
    tb = bigrams(nb.toLowerCase());
  }
  if (!ta.length || !tb.length) return 0;
  const counts = new Map<string, number>();
  for (const t of ta) counts.set(t, (counts.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of tb) {
    const c = counts.get(t);
    if (c) {
      overlap++;
      counts.set(t, c - 1);
    }
  }
  return (2 * overlap) / (ta.length + tb.length);
}

function bigrams(s: string): string[] {
  if (s.length < 2) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

export function truncate(text: string, max = 60): string {
  const t = normalizeText(text);
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
