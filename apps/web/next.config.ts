import type { NextConfig } from 'next';

const config: NextConfig = {
  // These read files and wasm from node_modules at runtime; keep them out of the server bundle.
  serverExternalPackages: ['@lineage/ingest', '@lineage/store-fs', '@vscode/tree-sitter-wasm', 'unpdf'],
  experimental: {
    serverActions: { bodySizeLimit: '50mb' },
  },
};

export default config;
