import type { Metadata } from 'next';
// Self-hosted fonts: no request to Google at build or run time.
import '@fontsource/overpass/latin-400.css';
import '@fontsource/overpass/latin-600.css';
import '@fontsource/overpass/latin-700.css';
import '@fontsource/overpass/latin-800.css';
import '@fontsource/overpass-mono/latin-400.css';
import '@fontsource/overpass-mono/latin-600.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Lineage', template: '%s · Lineage' },
  description: 'Git for research: version docs, LLM chats, PDFs and code with semantic diffs, branching and merging.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen text-ink">{children}</body>
    </html>
  );
}
