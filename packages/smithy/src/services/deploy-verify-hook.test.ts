import { describe, it, expect, vi } from 'vitest';
import type { PostMergeContext } from './post-merge-runner.js';
import { DeployVerifyHook } from './deploy-verify-hook.js';

function createContext(overrides: Partial<PostMergeContext> = {}): PostMergeContext {
  return {
    commitSha: 'abc123def456',
    changedFiles: [],
    sourceBranch: 'feature/post-merge',
    targetBranch: 'master',
    workspaceRoot: '/tmp/workspace',
    ...overrides,
  };
}

describe('DeployVerifyHook', () => {
  it('returns pass when all workflow runs succeed', async () => {
    const runGh = vi.fn().mockResolvedValue(JSON.stringify([
      {
        databaseId: 1,
        workflowName: 'CI',
        status: 'completed',
        conclusion: 'success',
        headSha: 'abc123def456',
      },
    ]));

    const hook = new DeployVerifyHook({ runGh, sleep: vi.fn(), timeoutMs: 100 });
    const result = await hook.execute(createContext());

    expect(result.status).toBe('pass');
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(runGh).toHaveBeenCalledTimes(1);
  });

  it('returns fail when any workflow run fails', async () => {
    const runGh = vi.fn().mockResolvedValue(JSON.stringify([
      {
        databaseId: 1,
        workflowName: 'CI',
        status: 'completed',
        conclusion: 'failure',
        headSha: 'abc123def456',
      },
    ]));

    const hook = new DeployVerifyHook({ runGh, sleep: vi.fn(), timeoutMs: 100 });
    const result = await hook.execute(createContext());

    expect(result.status).toBe('fail');
    expect(result.success).toBe(false);
    expect(result.message).toContain('GitHub Actions failed');
  });

  it('polls until a pending run passes', async () => {
    const runGh = vi.fn()
      .mockResolvedValueOnce(JSON.stringify([
        {
          databaseId: 1,
          workflowName: 'CI',
          status: 'in_progress',
          conclusion: '',
          headSha: 'abc123def456',
        },
      ]))
      .mockResolvedValueOnce(JSON.stringify([
        {
          databaseId: 1,
          workflowName: 'CI',
          status: 'completed',
          conclusion: 'success',
          headSha: 'abc123def456',
        },
      ]));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const hook = new DeployVerifyHook({
      runGh,
      sleep,
      pollIntervalMs: 5,
      timeoutMs: 50,
    });

    const result = await hook.execute(createContext());

    expect(result.status).toBe('pass');
    expect(result.attempts).toBe(2);
    expect(runGh).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5);
  });

  it('returns pending after the timeout expires with no runs', async () => {
    const runGh = vi.fn().mockResolvedValue(JSON.stringify([]));
    const sleep = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const hook = new DeployVerifyHook({
      runGh,
      sleep,
      pollIntervalMs: 1,
      timeoutMs: 0,
    });

    const result = await hook.execute(createContext());

    expect(result.status).toBe('pending');
    expect(result.success).toBe(false);
    expect(result.message).toContain('no workflow runs found');
  });

  it('passes repo through to gh when configured', async () => {
    const runGh = vi.fn().mockResolvedValue(JSON.stringify([
      {
        databaseId: 1,
        workflowName: 'CI',
        status: 'completed',
        conclusion: 'success',
        headSha: 'abc123def456',
      },
    ]));

    const hook = new DeployVerifyHook({
      repo: 'stoneforge-ai/stoneforge',
      runGh,
      sleep: vi.fn(),
    });

    await hook.execute(createContext());

    expect(runGh).toHaveBeenCalledWith(
      expect.arrayContaining(['--repo', 'stoneforge-ai/stoneforge']),
      expect.objectContaining({ commitSha: 'abc123def456' })
    );
  });
});
