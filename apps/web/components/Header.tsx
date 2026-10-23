import Link from 'next/link';
import type { MockUser } from '@/lib/users';
import { qs } from '@/lib/format';
import { HeaderPeers } from './live/Peers';
import { UserSwitcher } from './UserSwitcher';

type Section = 'map' | 'history' | 'compare' | 'merge' | 'ask' | 'import';

export function Logo() {
  return (
    <Link href="/" className="flex min-h-11 items-center gap-2.5 text-paper no-underline hover:text-paper">
      <span aria-hidden className="box-border inline-block size-5 rounded-full border-[5px] border-paper" />
      <span className="text-[19px] font-extrabold">Lineage</span>
    </Link>
  );
}

export function Header({
  user,
  returnTo,
  workspace,
  active,
  branch,
}: {
  user: MockUser;
  returnTo: string;
  workspace?: { slug: string; name: string };
  active?: Section;
  branch?: string;
}) {
  const b = branch && branch !== 'main' ? branch : undefined;
  const nav: { id: Section; label: string; href: string; soon?: boolean }[] = workspace
    ? [
        { id: 'map', label: 'Map', href: `/w/${workspace.slug}${qs({ b })}` },
        { id: 'history', label: 'History', href: `/w/${workspace.slug}/history${qs({ b })}` },
        { id: 'compare', label: 'Compare', href: `/w/${workspace.slug}/compare${qs({ b })}` },
        { id: 'merge', label: 'Merges', href: `/w/${workspace.slug}/merge` },
        { id: 'ask', label: 'Ask', href: `/w/${workspace.slug}/ask`, soon: true },
      ]
    : [];
  return (
    <header className="flex min-h-16 flex-wrap items-center gap-x-6 gap-y-2 bg-ink px-6 py-2 text-paper md:px-10">
      <Logo />
      {workspace && <span className="text-header-muted">{workspace.name}</span>}
      {nav.length > 0 && (
        <nav aria-label="Workspace" className="flex flex-wrap gap-x-5">
          {nav.map((n) => (
            <Link
              key={n.id}
              href={n.href}
              aria-current={active === n.id ? 'page' : undefined}
              className={`flex min-h-11 items-center gap-1.5 no-underline hover:text-paper ${
                active === n.id ? 'font-bold text-paper shadow-[inset_0_-3px_0_#FAFAF7]' : 'text-[#D5D7DE]'
              }`}
            >
              {n.label}
              {n.soon && <span className="rounded bg-[#2b2d33] px-1.5 text-[11px] text-header-muted">soon</span>}
            </Link>
          ))}
        </nav>
      )}
      <div className="flex-1" />
      {workspace && <HeaderPeers />}
      {workspace && (
        <Link
          href={`/w/${workspace.slug}/import${qs({ b })}`}
          className={`flex min-h-10 items-center rounded border border-muted px-3.5 font-semibold no-underline hover:text-paper ${
            active === 'import' ? 'bg-paper text-ink hover:text-ink' : 'text-paper'
          }`}
        >
          Import
        </Link>
      )}
      <UserSwitcher current={user.id} returnTo={returnTo} />
    </header>
  );
}
