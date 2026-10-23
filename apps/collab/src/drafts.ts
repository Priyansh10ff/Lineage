import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Yjs state of shared drafts, one binary file per (branch, path):
 *
 * ```
 * <root>/<slug>/drafts/<sha256(branch \0 path)>.ydoc
 * ```
 *
 * A draft only has a file while it holds uncommitted text; once it matches the branch again the
 * file is removed and the next session starts fresh from the commit.
 */
export class DraftFiles {
  constructor(private readonly root: string) {}

  file(slug: string, branch: string, path: string): string {
    const id = createHash('sha256').update(`${branch}\0${path}`).digest('hex').slice(0, 40);
    return join(this.root, slug, 'drafts', `${id}.ydoc`);
  }

  async read(slug: string, branch: string, path: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.file(slug, branch, path)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }

  async write(slug: string, branch: string, path: string, state: Uint8Array): Promise<void> {
    const file = this.file(slug, branch, path);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, state);
    await rename(tmp, file);
  }

  async remove(slug: string, branch: string, path: string): Promise<void> {
    await rm(this.file(slug, branch, path), { force: true });
  }
}
