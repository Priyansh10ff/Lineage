'use client';

import { useRef } from 'react';
import { setUser } from '@/app/actions';
import { USERS } from '@/lib/users';

/** Mock sign-in: pick who you are. Changes apply on select. */
export function UserSwitcher({ current, returnTo }: { current: string; returnTo: string }) {
  const form = useRef<HTMLFormElement>(null);
  return (
    <form ref={form} action={setUser} className="flex items-center gap-2">
      <input type="hidden" name="returnTo" value={returnTo} />
      <label htmlFor="user-switch" className="text-header-muted">
        Signed in as
      </label>
      <select
        id="user-switch"
        name="user"
        defaultValue={current}
        onChange={() => form.current?.requestSubmit()}
        className="min-h-10 rounded border border-muted bg-ink px-2 font-semibold text-paper"
      >
        {USERS.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
      <noscript>
        <button className="rounded border border-muted px-2">Switch</button>
      </noscript>
    </form>
  );
}
