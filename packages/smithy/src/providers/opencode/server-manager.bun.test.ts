import { describe, expect, it, mock } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface CreateOpencodeOptions {
  port: number;
  cwd?: string;
  env: Record<string, string>;
}

let capturedOptions: CreateOpencodeOptions | undefined;

mock.module('@opencode-ai/sdk', () => ({
  createOpencode: mock(async (options: CreateOpencodeOptions) => {
    capturedOptions = options;
    return {
      client: {},
      server: { close: mock(() => {}) },
    };
  }),
}));

describe('OpenCodeServerManager', () => {
  it('prepends the sf CLI bin directory to the server PATH', async () => {
    const { serverManager } = await import('./server-manager.js');

    await serverManager.acquire({ stoneforgeRoot: '/managed/project' });

    try {
      const expectedSfBinDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin');
      expect(capturedOptions?.env.PATH?.split(':')[0]).toBe(expectedSfBinDir);
    } finally {
      serverManager.release();
    }
  });
});
