const decoder = new TextDecoder('utf-8');

export function toText(data: Uint8Array | string): string {
  const text = typeof data === 'string' ? data : decoder.decode(data);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

/** A NUL byte in the first 8 KB is a reliable sign of a binary file. */
export function isBinary(data: Uint8Array): boolean {
  const n = Math.min(data.length, 8192);
  for (let i = 0; i < n; i++) if (data[i] === 0) return true;
  return false;
}

export function extname(name: string): string {
  const base = basename(name);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

export function basename(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop() ?? name;
}

export function stripExt(name: string): string {
  const base = basename(name);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(0, i) : base;
}

export function slugify(text: string, max = 60): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return slug || 'untitled';
}

/** Normalize a path for use in a workspace tree: forward slashes, no leading `./` or `/`, no `..`. */
export function cleanPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..')
    .join('/');
}

export function joinPath(...parts: (string | undefined)[]): string {
  return cleanPath(parts.filter(Boolean).join('/'));
}

/** Seconds (ChatGPT) or ISO string (Claude) to ISO. */
export function toIso(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return undefined;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
