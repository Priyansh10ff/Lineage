'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { USER_COOKIE, currentUser, registry } from '@/lib/data';
import { createDemoWorkspace } from '@/lib/demo';
import { USERS, asAuthor } from '@/lib/users';

/** Only allow redirects back into this app. */
function safeReturn(v: FormDataEntryValue | null): string {
  const s = typeof v === 'string' ? v : '/';
  return s.startsWith('/') && !s.startsWith('//') ? s : '/';
}

export async function setUser(form: FormData): Promise<void> {
  const id = String(form.get('user') ?? '');
  if (USERS.some((u) => u.id === id)) {
    (await cookies()).set(USER_COOKIE, id, { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
  }
  redirect(safeReturn(form.get('returnTo')));
}

export async function createWorkspace(form: FormData): Promise<void> {
  const name = String(form.get('name') ?? '').trim();
  if (!name) redirect('/?error=name');
  const description = String(form.get('description') ?? '').trim();
  const ws = await registry.create({ name, author: asAuthor(await currentUser()), ...(description ? { description } : {}) });
  redirect(`/w/${ws.meta.slug}`);
}

export async function createDemo(): Promise<void> {
  const slug = await createDemoWorkspace();
  redirect(`/w/${slug}`);
}
