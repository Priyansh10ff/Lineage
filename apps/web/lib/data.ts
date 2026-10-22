import 'server-only';
import { join } from 'node:path';
import { WorkspaceRegistry, type Workspace } from '@lineage/store-fs';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { userById, type MockUser } from './users';

const DATA_DIR = process.env.LINEAGE_DATA_DIR ?? join(process.cwd(), '.lineage');

/** One registry per server process. */
const globalForRegistry = globalThis as unknown as { lineageRegistry?: WorkspaceRegistry };
export const registry = (globalForRegistry.lineageRegistry ??= new WorkspaceRegistry(DATA_DIR));

export async function getWorkspace(slug: string): Promise<Workspace> {
  const ws = await registry.get(slug);
  if (!ws) notFound();
  return ws;
}

export const USER_COOKIE = 'lineage_user';

export async function currentUser(): Promise<MockUser> {
  return userById((await cookies()).get(USER_COOKIE)?.value);
}

/** The branch to show: `?b=` if it exists, else main, else the first branch. */
export async function pickBranch(ws: Workspace, requested?: string | string[]): Promise<{ branch: string; branches: Record<string, string> }> {
  const branches = await ws.repo.branches();
  const want = typeof requested === 'string' ? requested : undefined;
  const branch = want && want in branches ? want : 'main' in branches ? 'main' : Object.keys(branches)[0]!;
  return { branch, branches };
}

export function param(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
