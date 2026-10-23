'use client';

import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { DRAFT_META, DRAFT_TEXT, draftPresenceUser, draftRoom, textPatch, type DraftMeta, type DraftPresenceState } from '@lineage/realtime';
import { tags } from '@lezer/highlight';
import Link from 'next/link';
import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import { commitDraft, type DraftCommitResult } from '@/app/w/[ws]/actions';
import { qs, short } from '@/lib/format';
import { useLive } from './LiveProvider';
import { PeerAvatar } from './Peers';

/** How long to wait for the collaboration server before offering the plain editor. */
const OFFLINE_AFTER_MS = 4000;

const highlight = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: '800', fontSize: '1.25em' },
  { tag: tags.heading2, fontWeight: '800', fontSize: '1.12em' },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: '800' },
  { tag: tags.strong, fontWeight: '800' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: '#1F4FD1', textDecoration: 'underline' },
  { tag: tags.url, color: '#1F4FD1' },
  { tag: tags.quote, color: '#5D6069' },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: '#8B8E98' },
  { tag: tags.monospace, color: '#15389A' },
]);

const theme = EditorView.theme({
  '&': { fontFamily: 'var(--font-mono)', fontSize: '14px', backgroundColor: '#FFFFFF' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.75', minHeight: '440px', maxHeight: '70vh' },
  '.cm-content': { padding: '18px 0', caretColor: '#17181C' },
  '.cm-line': { padding: '0 20px' },
  '.cm-cursor': { borderLeftColor: '#17181C', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: '#DCE6FA !important' },
  // Other people's carets: a solid 2px bar with an always-visible name tag.
  '.cm-ySelectionCaret': { borderLeftWidth: '2px', borderRightWidth: '0', marginLeft: '-1px', marginRight: '-1px' },
  '.cm-ySelectionCaretDot': { display: 'none' },
  '.cm-ySelectionInfo': {
    opacity: '1',
    top: '-1.45em',
    left: '-2px',
    padding: '1px 6px',
    borderRadius: '3px 3px 3px 0',
    fontFamily: 'var(--font-sans)',
    fontSize: '11px',
    fontWeight: '700',
    color: '#FFFFFF',
  },
});

interface DraftPeer {
  clientId: number;
  user: DraftPresenceState['user'];
}

type Phase = 'connecting' | 'ready' | 'offline' | 'refused';

export interface DraftEditorProps {
  slug: string;
  branch: string;
  path: string;
  /** Rendered when the collaboration server can't be reached: the plain, commit-on-submit editor. */
  fallback: ReactNode;
  fileHref: string;
}

/**
 * A live, shared draft of one file: everyone on this page types into the same text and sees each
 * other's cursors. The draft lives on the collaboration server until someone commits it.
 */
export function DraftEditor({ slug, branch, path, fallback, fileHref }: DraftEditorProps) {
  const live = useLive();
  const host = useRef<HTMLDivElement>(null);
  const doc = useRef<Y.Doc | null>(null);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [meta, setMeta] = useState<DraftMeta>({});
  const [peers, setPeers] = useState<DraftPeer[]>([]);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<DraftCommitResult | null>(null);
  const [pending, start] = useTransition();

  const socket = live?.socket ?? null;
  const liveRef = useRef(live);
  liveRef.current = live;
  const selfId = live?.self.id;

  useEffect(() => {
    const current = liveRef.current;
    if (!socket || !current || !selfId) return;
    const self = current.self;
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText(DRAFT_TEXT);
    const ymeta = ydoc.getMap<unknown>(DRAFT_META);
    const undo = new Y.UndoManager(ytext);
    let view: EditorView | null = null;
    let disposed = false;

    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: draftRoom(slug, branch, path),
      document: ydoc,
      token: () => liveRef.current?.token() ?? '',
      onAuthenticationFailed: () => setPhase('refused'),
      onSynced: () => {
        if (disposed || view || !host.current) return;
        view = new EditorView({
          parent: host.current,
          state: EditorState.create({
            doc: ytext.toString(),
            extensions: [
              keymap.of([...yUndoManagerKeymap, ...defaultKeymap, indentWithTab]),
              drawSelection(),
              EditorView.lineWrapping,
              markdown(),
              syntaxHighlighting(highlight),
              theme,
              EditorView.contentAttributes.of({ 'aria-label': `Shared draft of ${path}`, 'aria-multiline': 'true' }),
              yCollab(ytext, provider.awareness, { undoManager: undo }),
            ],
          }),
        });
        setPhase('ready');
      },
    });
    provider.attach();
    doc.current = ydoc;

    const syncMeta = () => setMeta(ymeta.toJSON() as DraftMeta);
    ymeta.observe(syncMeta);
    syncMeta();

    const awareness = provider.awareness!;
    awareness.setLocalStateField('user', draftPresenceUser(self));
    const onAwareness = () => {
      const byUser = new Map<string, DraftPeer>();
      for (const [clientId, state] of awareness.getStates()) {
        const u = (state as Partial<DraftPresenceState>).user;
        if (clientId === awareness.clientID || !u || u.id === self.id) continue;
        byUser.set(u.id, { clientId, user: u });
      }
      setPeers([...byUser.values()]);
    };
    awareness.on('change', onAwareness);

    const offline = setTimeout(() => {
      if (!view && !disposed) setPhase((p) => (p === 'connecting' ? 'offline' : p));
    }, OFFLINE_AFTER_MS);

    return () => {
      disposed = true;
      clearTimeout(offline);
      awareness.off('change', onAwareness);
      ymeta.unobserve(syncMeta);
      view?.destroy();
      provider.destroy();
      undo.destroy();
      ydoc.destroy();
      doc.current = null;
    };
  }, [socket, selfId, slug, branch, path]);

  /** Make the shared text read `next`, touching as little as possible so others' cursors stay put. */
  const adopt = (next: string) => {
    const ydoc = doc.current;
    if (!ydoc) return;
    const ytext = ydoc.getText(DRAFT_TEXT);
    const p = textPatch(ytext.toString(), next);
    if (!p) return;
    ydoc.transact(() => {
      if (p.remove) ytext.delete(p.index, p.remove);
      if (p.insert) ytext.insert(p.index, p.insert);
    });
  };

  const commit = (asNewLine = false) => {
    const ydoc = doc.current;
    if (!ydoc || !meta.base) return;
    const text = ydoc.getText(DRAFT_TEXT).toString();
    start(async () => {
      const r = await commitDraft({ ws: slug, branch, path, text, base: meta.base!, message, asNewLine });
      if (r.ok) {
        if (r.adoptText !== undefined) adopt(r.adoptText);
        if (!r.unchanged) setMessage('');
      }
      setResult(r);
    });
  };

  if (phase === 'offline' || !live) {
    return (
      <div className="flex flex-col gap-4">
        <div role="status" className="rounded border-l-4 border-[#C46A00] bg-warn-bg px-4 py-3 text-warn-fg">
          <b>Live editing is offline.</b> The collaboration server isn&rsquo;t reachable, so this editor works on your own copy and commits when you submit.{' '}
          <button type="button" className="font-bold underline" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
        {fallback}
      </div>
    );
  }

  const b = branch === 'main' ? undefined : branch;
  const moved = !!meta.base && !!meta.head && meta.base !== meta.head;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-center gap-2 font-bold">
          <span aria-hidden className={`inline-block size-2.5 rounded-full ${phase === 'ready' ? 'bg-[#22A55B]' : 'bg-[#F4A340]'}`} />
          {phase === 'ready' ? 'Shared draft' : phase === 'refused' ? 'Not allowed to join this draft' : 'Joining the draft'}
        </span>
        {meta.isNew && <span className="sign border border-ink">NEW FILE</span>}
        <div className="flex-1" />
        {phase === 'ready' && (
          <span className="flex items-center gap-2 text-muted" role="status" aria-live="polite">
            {peers.length ? (
              <>
                <span className="flex items-center">
                  {peers.map((p, i) => (
                    <span key={p.user.id} className={i ? '-ml-1.5' : ''}>
                      <PeerAvatar user={{ ...p.user, color: p.user.avatar }} ring="#FFFFFF" />
                    </span>
                  ))}
                </span>
                <span>
                  Editing with <b className="text-ink">{peers.map((p) => p.user.name).join(', ')}</b>
                </span>
              </>
            ) : (
              'Only you right now. Anyone who opens this file joins the same draft.'
            )}
          </span>
        )}
      </div>

      {meta.gone && (
        <div role="alert" className="rounded border-l-4 border-[#C46A00] bg-warn-bg px-4 py-3 font-semibold text-warn-fg">
          The {branch} line was deleted. Copy anything you want to keep; this draft can&rsquo;t be committed.
        </div>
      )}
      {moved && !meta.gone && (
        <div role="status" className="rounded border-l-4 border-line-main bg-line-main-tint px-4 py-3">
          <b>{branch} moved on</b> since this draft started ({short(meta.base!)} → {short(meta.head!)}). Committing merges the draft with the new version, paragraph by paragraph.
        </div>
      )}

      <div className="relative overflow-hidden rounded border-2 border-ink bg-white focus-within:shadow-[0_0_0_3px_#1F4FD1]">
        <div ref={host} />
        {phase !== 'ready' && <div className="grid min-h-[440px] place-items-center text-muted">Loading the draft…</div>}
      </div>

      <form
        className="flex flex-wrap items-end gap-3 border-t-2 border-ink pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          commit();
        }}
      >
        <label className="flex min-w-[280px] flex-1 flex-col gap-1">
          <span className="font-bold">Commit message</span>
          <input value={message} onChange={(e) => setMessage(e.target.value)} className="field" placeholder={meta.isNew ? `Add ${path}` : `Edit ${path}`} />
        </label>
        <span className="pb-3 text-muted">
          to <b className="text-ink">{branch}</b>
          {meta.head ? ` after ${short(meta.head)}` : ''}
        </span>
        <button className="btn-ink" disabled={phase !== 'ready' || pending || meta.gone}>
          {pending ? 'Committing…' : 'Commit'}
        </button>
      </form>

      {result && <CommitResult result={result} slug={slug} branch={branch} b={b} fileHref={fileHref} onNewLine={() => commit(true)} pending={pending} />}

      <p className="m-0 text-muted">
        Everyone here edits one draft; a commit records it as a stop on {branch} under your name. Uncommitted text stays on the server, so you can close the tab and come back.
      </p>
    </div>
  );
}

function CommitResult({
  result,
  slug,
  branch,
  b,
  fileHref,
  onNewLine,
  pending,
}: {
  result: DraftCommitResult;
  slug: string;
  branch: string;
  b: string | undefined;
  fileHref: string;
  onNewLine: () => void;
  pending: boolean;
}) {
  if (!result.ok) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded border-l-4 border-[#C46A00] bg-warn-bg px-4 py-3 text-warn-fg">
        <span className="font-semibold">{result.error}</span>
        {result.conflict && (
          <>
            <span>Put the draft on its own line and resolve it on the merge page.</span>
            <button type="button" className="btn-line min-h-9" disabled={pending} onClick={onNewLine}>
              Commit to a new line
            </button>
          </>
        )}
      </div>
    );
  }
  if (result.newLine) {
    return (
      <div role="status" className="flex flex-wrap items-center gap-3 rounded border-l-4 border-agent bg-[#E3F4EC] px-4 py-3">
        <span>
          Your draft is on the new line <b>{result.newLine}</b> ({short(result.head)}). This draft is back to what {branch} says.
        </span>
        <Link href={`/w/${slug}/merge${qs({ from: result.newLine, into: branch })}`} className="font-bold">
          Review the merge
        </Link>
      </div>
    );
  }
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded border-l-4 border-agent bg-[#E3F4EC] px-4 py-3">
      <span>
        {result.unchanged ? (
          <>Nothing to commit: the draft matches {branch}.</>
        ) : (
          <>
            Committed <b className="font-mono">{short(result.head)}</b> to {branch}
            {result.adoptText !== undefined ? ', merged with the newer version' : ''}.
          </>
        )}
      </span>
      <Link href={fileHref} className="font-bold">
        View file
      </Link>
      <Link href={`/w/${slug}${qs({ b })}`} className="font-bold">
        Map
      </Link>
    </div>
  );
}
