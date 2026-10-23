import { describe, expect, it } from 'vitest';
import { draftRoom, lighten, parseRoom, parseServerMessage, textPatch, workspaceRoom } from '../src/index.js';
import { collabSecret, signToken, verifyToken } from '../src/token.js';

const user = { id: 'alice', name: 'Alice', initials: 'AL', color: '#F4A340', kind: 'human' as const };

describe('rooms', () => {
  it('round-trips workspace and draft rooms', () => {
    expect(parseRoom(workspaceRoom('sleep-study'))).toEqual({ type: 'workspace', slug: 'sleep-study' });
    const name = draftRoom('sleep-study', 'agent/summary:v2', 'docs/notes: draft.md');
    expect(parseRoom(name)).toEqual({ type: 'draft', slug: 'sleep-study', branch: 'agent/summary:v2', path: 'docs/notes: draft.md' });
  });

  it('rejects malformed names and path escapes', () => {
    for (const bad of ['', 'ws:', 'ws:Bad', 'ws:a:b', 'draft:a:main', 'draft:a::x.md', `draft:a:main:${encodeURIComponent('../x')}`, `draft:a:main:${encodeURIComponent('/etc/passwd')}`, 'draft:a:main:%E0%A4%A']) {
      expect(parseRoom(bad)).toBeUndefined();
    }
  });
});

describe('tokens', () => {
  it('verifies what it signs', () => {
    const t = signToken({ user, ws: 'demo' }, 's3cret');
    expect(verifyToken(t, 's3cret')).toMatchObject({ user, ws: 'demo' });
  });

  it('rejects a wrong secret, tampering and expiry', () => {
    const t = signToken({ user, ws: 'demo', ttlSeconds: 60 }, 's3cret', 1_000_000);
    expect(verifyToken(t, 'other', 1_000_000)).toBeUndefined();
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ user: { ...user, id: 'priyansh' }, ws: 'demo', exp: 9e9 })).toString('base64url');
    expect(verifyToken(`${forged}.${sig}`, 's3cret', 1_000_000)).toBeUndefined();
    expect(verifyToken(`${body}.${sig}.x`, 's3cret', 1_000_000)).toBeUndefined();
    expect(verifyToken(t, 's3cret', 1_000_000 + 61_000)).toBeUndefined();
  });

  it('requires a secret in production', () => {
    expect(() => collabSecret({ NODE_ENV: 'production' })).toThrow(/LINEAGE_COLLAB_SECRET/);
    expect(collabSecret({ NODE_ENV: 'production', LINEAGE_COLLAB_SECRET: 'x' })).toBe('x');
    expect(collabSecret({})).toBeTruthy();
  });
});

describe('helpers', () => {
  it('computes minimal text patches', () => {
    expect(textPatch('abc', 'abc')).toBeUndefined();
    expect(textPatch('hello world', 'hello brave world')).toEqual({ index: 6, remove: 0, insert: 'brave ' });
    expect(textPatch('aaa', 'aa')).toEqual({ index: 2, remove: 1, insert: '' });
    const from = 'one\n\ntwo\n\nthree';
    const to = 'one\n\nTWO!\n\nthree';
    const p = textPatch(from, to)!;
    expect(from.slice(0, p.index) + p.insert + from.slice(p.index + p.remove)).toBe(to);
  });

  it('parses server messages defensively', () => {
    expect(parseServerMessage('{"type":"refs","changes":[]}')).toEqual({ type: 'refs', changes: [] });
    expect(parseServerMessage('nope')).toBeUndefined();
    expect(parseServerMessage('{"type":"other"}')).toBeUndefined();
  });

  it('tints colors', () => {
    expect(lighten('#F4A340')).toBe('#F4A34054');
    expect(lighten('red')).toBe('red');
  });
});
