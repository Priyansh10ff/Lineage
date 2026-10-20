import { MemoryStore, Repository, parseProse, type Author, type Doc, type Unit } from '../src/index.js';

export const alice: Author = { id: 'u1', name: 'Alice' };
export const bob: Author = { id: 'u2', name: 'Bob' };

/** Deterministic clock: each call is one minute after the last. */
export function clock(start = Date.UTC(2026, 0, 1)) {
  let t = start;
  return () => new Date((t += 60_000));
}

export async function makeRepo() {
  const store = new MemoryStore();
  const repo = await Repository.init(store, { author: alice }, { now: clock() });
  return { store, repo };
}

export const md = (text: string) => parseProse(text);

export function chat(...turns: [role: string, text: string][]): Doc {
  return { kind: 'chat', units: turns.map(([role, text]): Unit => ({ type: 'turn', text, meta: { role } })) };
}

export const paper = `# Sleep and memory

## Abstract

We study how sleep affects memory consolidation. Participants slept for eight hours. Recall improved by 20%.

## Methods

We recruited 40 participants from a university campus. Each completed a word-pair task before sleeping.

## Results

Recall improved significantly after sleep. The effect was strongest for emotional words.`;
