import { PDFDocument, StandardFonts } from 'pdf-lib';

type Line = { text: string; size?: number; gap?: number };

/**
 * Build a small two-column-free "paper": title, headings, wrapped paragraphs with paragraph
 * spacing, a hyphenated line break, running header + page numbers, and a paragraph that
 * continues across the page break.
 */
export async function makePaper(
  opts: { title?: string; pages?: Line[][]; furniture?: boolean } = {},
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  if (opts.title) pdf.setTitle(opts.title);
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const pages = opts.pages ?? DEFAULT_PAGES;
  pages.forEach((lines, i) => {
    const page = pdf.addPage([612, 792]);
    const furniture = opts.furniture ?? true;
    if (furniture) page.drawText('Journal of Reproducible Tests', { x: 72, y: 760, size: 8, font });
    let y = 720;
    for (const l of lines) {
      y -= l.gap ?? 14;
      const size = l.size ?? 11;
      page.drawText(l.text, { x: 72, y, size, font: size > 11 ? bold : font });
    }
    if (furniture) page.drawText(String(i + 1), { x: 300, y: 40, size: 9, font });
  });
  return pdf.save();
}

export const DEFAULT_PAGES: Line[][] = [
  [
    { text: 'Sleep and Memory Consolidation', size: 20, gap: 0 },
    { text: 'Abstract', size: 13, gap: 36 },
    { text: 'We study how sleep affects memory consolidation in adults. Participants slept for', gap: 20 },
    { text: 'eight hours before a recall test. Recall improved by twenty percent.' },
    { text: '1. Introduction', size: 13, gap: 30 },
    { text: 'Memory consolidation is thought to depend on sleep. Prior work used small sam-', gap: 20 },
    { text: 'ples and short retention intervals.' },
    { text: 'We address both limitations with a larger cohort and a longer delay between', gap: 24 },
    { text: 'learning and testing, which lets us separate consolidation from' },
  ],
  [
    { text: 'simple rehearsal effects observed in earlier experiments.', gap: 0 },
    { text: '2. Methods', size: 13, gap: 30 },
    { text: 'We recruited forty participants from a university campus.', gap: 20 },
  ],
];
