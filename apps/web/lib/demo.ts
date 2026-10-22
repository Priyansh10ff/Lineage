import 'server-only';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Repository, parseProse, type Doc } from '@lineage/core';
import { createNodeCodeParser, ingest } from '@lineage/ingest/node';
import { registry } from './data';
import { AGENT, USERS, asAuthor } from './users';

const [priyansh, alice, bob] = USERS.map(asAuthor) as [ReturnType<typeof asAuthor>, ReturnType<typeof asAuthor>, ReturnType<typeof asAuthor>];
const agent = asAuthor(AGENT);

const paper = (v: { n: number; sessions?: boolean; results: string; intro2?: boolean; abstract2?: boolean }) => `# Sleep and memory consolidation

## Abstract

We study how sleep affects memory consolidation in adults. ${v.abstract2 ? 'Participants slept for eight hours before a morning recall test.' : 'Participants slept before a recall test.'}

## Introduction

Memory consolidation is thought to depend on sleep, but prior studies used small samples.${
  v.intro2 ? '\n\nA review of the field (papers/consolidation-review.pdf) separates active systems and synaptic homeostasis accounts.' : ''
}

## Methods

We recruited ${v.n} participants from a university campus. Each completed a word-pair task before sleeping.${v.sessions ? ' Sessions were held at 9pm.' : ''}

Polysomnography was recorded overnight. Slow-wave sleep was scored in 30-second epochs by two raters blind to condition.

## Results

${v.results} The effect was strongest for emotional words.

Retention after the wake interval did not differ from baseline.
`;

const analysis = (sample: boolean) => `import math
from dataclasses import dataclass


@dataclass
class Result:
    mean: float
    sd: float


def summarize(xs):
    """Mean and standard deviation."""
    m = sum(xs) / len(xs)
    sd = math.sqrt(sum((x - m) ** 2 for x in xs) / ${sample ? '(len(xs) - 1)' : 'len(xs)'})
    return Result(m, sd)


if __name__ == "__main__":
    print(summarize([1, 2, 3]))
`;

/** Build the "Sleep & Memory Study" demo: several authors, a merged branch, and an agent branch with a real conflict. */
export async function createDemoWorkspace(): Promise<string> {
  const ws = await registry.create({ name: 'Sleep & Memory Study (demo)', author: priyansh });
  // Spread the history over the last few days so the map and times read naturally.
  let t = Date.now() - 2 * 24 * 3600_000;
  const repo = new Repository(ws.store, { now: () => new Date((t += 2 * 3600_000 + Math.floor(Math.random() * 3600_000))) });
  const codeParser = createNodeCodeParser();
  const demo = (f: string) => readFile(join(process.cwd(), 'demo', f));
  const docs = async (name: string, data: Uint8Array | string) => {
    const r = await ingest({ name, data }, { codeParser });
    return Object.fromEntries(r.artifacts.map((a) => [a.path, a.doc] as [string, Doc]));
  };

  await repo.commit({
    branch: 'main',
    author: priyansh,
    message: 'Draft the paper and analysis script',
    changes: {
      'docs/paper.md': parseProse(paper({ n: 40, results: 'Recall improved significantly after sleep.' })),
      ...(await docs('analysis.py', analysis(false))),
    },
  });
  await repo.commit({ branch: 'main', author: priyansh, message: 'Add the consolidation review PDF', changes: await docs('consolidation-review.pdf', await demo('consolidation-review.pdf')) });
  await repo.commit({
    branch: 'main',
    author: bob,
    message: 'Import study-design chat and RAG notes chat',
    changes: { ...(await docs('conversations.json', await demo('claude-conversations.json'))), ...(await docs('conversations.json', await demo('chatgpt-conversations.json'))) },
  });

  await repo.createBranch('alice/lit-review', 'main');
  await repo.commit({
    branch: 'alice/lit-review',
    author: alice,
    message: 'Start reading notes',
    changes: { 'docs/reading-notes.md': parseProse('# Reading notes\n\n## Consolidation review\n\nSeparates active systems and synaptic homeostasis accounts. Useful framing for our introduction.\n\n## Chunking for our notes search\n\nThe RAG chat suggests chunking by section with 300 to 800 tokens.') },
  });
  await repo.commit({
    branch: 'alice/lit-review',
    author: alice,
    message: 'Cite the review in the introduction',
    changes: { 'docs/paper.md': parseProse(paper({ n: 40, intro2: true, results: 'Recall improved significantly after sleep.' })) },
  });
  await repo.commit({
    branch: 'main',
    author: priyansh,
    message: 'Tighten the abstract',
    changes: { 'docs/paper.md': parseProse(paper({ n: 40, abstract2: true, results: 'Recall improved significantly after sleep.' })) },
  });
  await repo.merge({ into: 'main', from: 'alice/lit-review', author: priyansh, message: 'Merge alice/lit-review into main' });

  // The agent branches off before Alice's revision and rewrites the same Results sentence.
  await repo.createBranch('agent/summarize', 'main');
  const base = { abstract2: true, intro2: true };
  await repo.commit({
    branch: 'agent/summarize',
    author: agent,
    message: 'Summarize results in plain language',
    changes: { 'docs/paper.md': parseProse(paper({ ...base, n: 40, results: "People remembered more after a night's sleep." })) },
  });
  await repo.commit({
    branch: 'main',
    author: alice,
    message: 'Revise methods after power analysis',
    changes: {
      'docs/paper.md': parseProse(paper({ ...base, n: 64, sessions: true, results: 'Recall improved by 23% after sleep.' })),
      ...(await docs('analysis.py', analysis(true))),
    },
  });
  return ws.meta.slug;
}
