import { Suspense, type ReactNode } from 'react';
import { LiveProvider } from '@/components/live/LiveProvider';
import { currentUser, getWorkspace } from '@/lib/data';
import { liveConnection } from '@/lib/live';

/** Every workspace page shares one live connection: presence, and branch updates from others. */
export default async function WorkspaceLayout({ children, params }: { children: ReactNode; params: Promise<{ ws: string }> }) {
  const { ws: slug } = await params;
  const [ws, user] = await Promise.all([getWorkspace(slug), currentUser()]);
  const live = liveConnection(user, ws.meta.slug);
  return (
    <Suspense fallback={children}>
      <LiveProvider slug={ws.meta.slug} token={live.token} url={live.url} self={live.user}>
        {children}
      </LiveProvider>
    </Suspense>
  );
}
