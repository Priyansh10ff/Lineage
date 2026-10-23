'use client';

import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import {
  parseServerMessage,
  workspaceRoom,
  type PresencePage,
  type PresenceState,
  type PresenceUser,
  type PresenceView,
  type RefChange,
} from '@lineage/realtime';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type LiveStatus = 'connecting' | 'live' | 'offline';

export interface Peer extends PresenceState {
  clientId: number;
}

interface LiveValue {
  slug: string;
  /** Latest connection token (changes on every server render; read it when connecting). */
  token: () => string;
  self: PresenceUser;
  socket: HocuspocusProviderWebsocket | null;
  status: LiveStatus;
  /** Other people in the workspace, one entry per person (their most recent tab). */
  peers: Peer[];
}

const LiveContext = createContext<LiveValue | null>(null);

/** Live workspace state, or `null` outside a workspace. */
export function useLive(): LiveValue | null {
  return useContext(LiveContext);
}

const PAGES = new Set<PresencePage>(['file', 'edit', 'history', 'compare', 'merge', 'import', 'ask']);
/** Pages with forms whose state an automatic refresh could disturb: these ask first. */
const ASK_BEFORE_REFRESH = new Set<PresencePage>(['edit', 'merge', 'import']);

function viewFrom(pathname: string, search: URLSearchParams): PresenceView {
  const [, , , section, ...rest] = pathname.split('/');
  const page: PresencePage = section && PAGES.has(section as PresencePage) ? (section as PresencePage) : 'map';
  const branch = search.get('b') || search.get('into') || 'main';
  let path: string | undefined;
  if (page === 'file') path = rest.map((s) => decodeURIComponent(s)).join('/');
  if (page === 'edit') path = search.get('path') ?? undefined;
  return path ? { page, branch, path } : { page, branch };
}

function defaultUrl(): string {
  const { protocol, hostname } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${hostname}:1234`;
}

interface Toast {
  id: number;
  text: string;
  refresh: boolean;
}

function describe(c: RefChange, self: PresenceUser): string | undefined {
  if (c.author === self.name) return undefined;
  const who = c.author ?? 'Someone';
  if (!c.to) return `The ${c.branch} line was removed`;
  if (!c.from) return `${who} started the ${c.branch} line`;
  return `${who} added a stop on ${c.branch}${c.message ? `: ${c.message}` : ''}`;
}

/**
 * Joins the workspace room on the collaboration server: publishes where you are, tracks who
 * else is here, and refreshes the page when someone moves a branch. One websocket per tab,
 * shared with any draft being edited.
 */
export function LiveProvider({ slug, token, url, self, children }: { slug: string; token: string; url: string | null; self: PresenceUser; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const view = useMemo(() => viewFrom(pathname, new URLSearchParams(search.toString())), [pathname, search]);

  const [socket, setSocket] = useState<HocuspocusProviderWebsocket | null>(null);
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [peers, setPeers] = useState<Peer[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const provider = useRef<HocuspocusProvider | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const selfRef = useRef(self);
  selfRef.current = self;
  // Tokens are re-signed on every server render; read the latest at (re)connect time instead of
  // reconnecting whenever the string changes.
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  useEffect(() => {
    const ws = new HocuspocusProviderWebsocket({ url: url ?? defaultUrl(), delay: 1500, maxDelay: 15000 });
    const p = new HocuspocusProvider({
      websocketProvider: ws,
      name: workspaceRoom(slug),
      token: () => tokenRef.current,
      onStatus: ({ status }) => setStatus(status === 'connected' ? 'live' : status === 'connecting' ? 'connecting' : 'offline'),
      onAuthenticationFailed: () => setStatus('offline'),
      onStateless: ({ payload }) => {
        const msg = parseServerMessage(payload);
        if (msg?.type !== 'refs') return;
        const lines = msg.changes.map((c) => describe(c, selfRef.current)).filter((t): t is string => !!t);
        const ask = ASK_BEFORE_REFRESH.has(viewRef.current.page);
        if (!ask) router.refresh();
        if (lines.length) {
          const id = Date.now() + Math.random();
          setToasts((t) => [...t.slice(-2), { id, text: lines.join(' · '), refresh: ask }]);
          setTimeout(() => dismiss(id), 9000);
        }
      },
    });
    p.attach();
    const awareness = p.awareness!;
    const onChange = () => {
      const byUser = new Map<string, Peer>();
      for (const [clientId, state] of awareness.getStates()) {
        if (clientId === awareness.clientID) continue;
        const s = state as Partial<PresenceState>;
        if (!s.user || !s.view || s.user.id === selfRef.current.id) continue;
        // Several tabs of one person: keep the one with the highest client clock, i.e. the latest.
        byUser.set(s.user.id, { clientId, user: s.user, view: s.view });
      }
      setPeers([...byUser.values()].sort((a, b) => a.user.name.localeCompare(b.user.name)));
    };
    awareness.on('change', onChange);
    awareness.setLocalState({ user: selfRef.current, view: viewRef.current } satisfies PresenceState);
    provider.current = p;
    setSocket(ws);
    return () => {
      awareness.off('change', onChange);
      p.destroy();
      ws.destroy();
      provider.current = null;
      setSocket(null);
      setPeers([]);
    };
  }, [slug, self.id, url, router, dismiss]);

  useEffect(() => {
    provider.current?.awareness?.setLocalStateField('view', view);
  }, [view]);

  const getToken = useCallback(() => tokenRef.current, []);
  const value = useMemo<LiveValue>(() => ({ slug, token: getToken, self, socket, status, peers }), [slug, getToken, self, socket, status, peers]);

  return (
    <LiveContext.Provider value={value}>
      {children}
      {toasts.length > 0 && (
        <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 flex max-w-[min(420px,calc(100vw-32px))] flex-col gap-2">
          {toasts.map((t) => (
            <div key={t.id} className="card pointer-events-auto flex items-start gap-3 bg-white px-4 py-3 shadow-[4px_4px_0_#17181C]">
              <span aria-hidden className="mt-1.5 inline-block size-2.5 shrink-0 rounded-full bg-line-main" />
              <span className="flex-1">{t.text}</span>
              {t.refresh && (
                <button
                  type="button"
                  className="font-bold text-line-main underline"
                  onClick={() => {
                    router.refresh();
                    dismiss(t.id);
                  }}
                >
                  Refresh
                </button>
              )}
              <button type="button" aria-label="Dismiss" className="text-muted" onClick={() => dismiss(t.id)}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </LiveContext.Provider>
  );
}
