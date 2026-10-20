import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Hash, LineageObject } from './types.js';

/**
 * Deterministic JSON: object keys sorted, `undefined` fields dropped.
 * Two structurally equal objects always encode to the same string, so they hash the same.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError(`Cannot canonicalize non-finite number: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : canonicalize(v))).join(',')}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

export function sha256Hex(input: string): Hash {
  return bytesToHex(sha256(utf8ToBytes(input)));
}

/** Content address of an object. The type prefix keeps a blob and a tree with equal JSON from colliding. */
export function hashObject(obj: LineageObject): Hash {
  return sha256Hex(`${obj.type}\0${canonicalize(obj)}`);
}
