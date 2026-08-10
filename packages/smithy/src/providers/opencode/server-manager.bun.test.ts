import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * These tests assert on `process.env`, NOT on the options object handed to
 * `createOpencode`. The SDK's ServerOptions type has no `env` field and its
 * implementation spawns with `{ ...process.env }`, so anything passed as `env`
 * is discarded. A test that inspected the call arguments would pass against a
 * completely inert implementation — which is exactly what happened before.
 */

mock.module('@opencode-ai/sdk', () => ({
  createOpencode: mock(async () => ({
    client: {},
    server: { close: mock(() => {}) },
  })),
}));

describe('applyOpenCodeEnv', () => {
  let originalPath: string | undefined;
  let originalPermission: string | undefined;
  let originalClient: string | undefined;
  let originalRoot: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
    originalPermission = process.env.OPENCODE_PERMISSION;
    originalClient = process.env.OPENCODE_CLIENT;
    originalRoot = process.env.STONEFORGE_ROOT;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalPermission === undefined) delete process.env.OPENCODE_PERMISSION;
    else process.env.OPENCODE_PERMISSION = originalPermission;
    if (originalClient === undefined) delete process.env.OPENCODE_CLIENT;
    else process.env.OPENCODE_CLIENT = originalClient;
    if (originalRoot === undefined) delete process.env.STONEFORGE_ROOT;
    else process.env.STONEFORGE_ROOT = originalRoot;
  });

  it('puts the sf CLI bin directory first on process.env.PATH', async () => {
    const { applyOpenCodeEnv, SF_BIN_DIR } = await import('./server-manager.js');
    process.env.PATH = '/usr/bin:/bin';

    applyOpenCodeEnv();

    expect(process.env.PATH?.split(':')[0]).toBe(SF_BIN_DIR);
    expect(process.env.PATH?.split(':')).toContain('/usr/bin');
  });

  it('does not prepend the bin directory twice when called repeatedly', async () => {
    const { applyOpenCodeEnv, SF_BIN_DIR } = await import('./server-manager.js');
    process.env.PATH = '/usr/bin:/bin';

    applyOpenCodeEnv();
    applyOpenCodeEnv();
    applyOpenCodeEnv();

    const occurrences = process.env.PATH?.split(':').filter((p) => p === SF_BIN_DIR).length;
    expect(occurrences).toBe(1);
  });

  it('sets the OpenCode permission and client markers on process.env', async () => {
    const { applyOpenCodeEnv } = await import('./server-manager.js');
    delete process.env.OPENCODE_PERMISSION;
    delete process.env.OPENCODE_CLIENT;

    applyOpenCodeEnv();

    expect(process.env.OPENCODE_PERMISSION).toBe(JSON.stringify({ '*': 'allow' }));
    expect(process.env.OPENCODE_CLIENT).toBe('stoneforge');
  });

  it('sets STONEFORGE_ROOT only when a root is supplied', async () => {
    const { applyOpenCodeEnv } = await import('./server-manager.js');
    delete process.env.STONEFORGE_ROOT;

    applyOpenCodeEnv();
    expect(process.env.STONEFORGE_ROOT).toBeUndefined();

    applyOpenCodeEnv('/managed/project');
    expect(process.env.STONEFORGE_ROOT).toBe('/managed/project');
  });

  it('handles an empty PATH without leaving a trailing separator', async () => {
    const { applyOpenCodeEnv, SF_BIN_DIR } = await import('./server-manager.js');
    process.env.PATH = '';

    applyOpenCodeEnv();

    expect(process.env.PATH).toBe(SF_BIN_DIR);
  });
});

describe('OpenCodeServerManager', () => {
  it('applies the OpenCode env before starting the server', async () => {
    const originalPath = process.env.PATH;
    const { serverManager, SF_BIN_DIR } = await import('./server-manager.js');
    process.env.PATH = '/usr/bin:/bin';

    try {
      await serverManager.acquire({ stoneforgeRoot: '/managed/project' });
      expect(process.env.PATH?.split(':')[0]).toBe(SF_BIN_DIR);
      expect(process.env.STONEFORGE_ROOT).toBe('/managed/project');
    } finally {
      serverManager.release();
      process.env.PATH = originalPath;
      delete process.env.STONEFORGE_ROOT;
    }
  });
});
