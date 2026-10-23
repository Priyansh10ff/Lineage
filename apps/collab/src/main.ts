import { join, resolve } from 'node:path';
import { collabSecret } from '@lineage/realtime/token';
import { createCollabServer } from './server.js';

// Defaults match the web app's: its data lives in apps/web/.lineage.
const dataDir = resolve(process.env['LINEAGE_DATA_DIR'] ?? join(process.cwd(), '..', 'web', '.lineage'));
const port = Number(process.env['LINEAGE_COLLAB_PORT'] ?? 1234);

const collab = createCollabServer({ dataDir, port, secret: collabSecret(), quiet: true });
const actual = await collab.listen();
console.log(`Lineage collab listening on ws://localhost:${actual} (data: ${dataDir})`);

const stop = async () => {
  await collab.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
