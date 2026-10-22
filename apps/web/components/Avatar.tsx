import { userById } from '@/lib/users';

export function Avatar({ userId, name, size = 30 }: { userId: string; name?: string; size?: number }) {
  const u = userById(userId);
  const known = u.id === userId;
  return (
    <span
      aria-hidden
      className="inline-grid shrink-0 place-items-center rounded-full font-extrabold text-ink"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38), background: known ? u.color : '#E2E3E8' }}
      title={name ?? u.name}
    >
      {known ? u.initials : (name ?? '?').slice(0, 2).toUpperCase()}
    </span>
  );
}
