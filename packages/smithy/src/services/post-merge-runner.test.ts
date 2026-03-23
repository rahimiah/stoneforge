/**
 * Post-Merge Runner Tests
 *
 * Tests the runAndRemediate method and hook management for PostMergeRunner.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PostMergeHook, PostMergeContext } from './post-merge-runner.js';
import { PostMergeRunnerImpl } from './post-merge-runner.js';

// ============================================================================
// Mocks
// ============================================================================

function createMockApi() {
  return {
    create: vi.fn().mockResolvedValue({ id: 'el-mock-task' }),
    get: vi.fn(),
    update: vi.fn(),
    list: vi.fn(),
    search: vi.fn(),
    delete: vi.fn(),
  } as any;
}

function createMockContext(overrides?: Partial<PostMergeContext>): PostMergeContext {
  return {
    commitSha: 'abc123def456',
    changedFiles: ['src/index.ts', 'README.md'],
    sourceBranch: 'feature/my-feature',
    targetBranch: 'master',
    workspaceRoot: '/tmp/test-workspace',
    taskId: 'el-1234' as any,
    ...overrides,
  };
}

function createSuccessHook(name = 'success-hook'): PostMergeHook {
  return {
    name,
    description: `A hook that succeeds: ${name}`,
    execute: vi.fn().mockResolvedValue({ success: true, message: 'All good' }),
  };
}

function createFailingHook(name = 'failing-hook', error = 'Something went wrong'): PostMergeHook {
  return {
    name,
    description: `A hook that fails: ${name}`,
    execute: vi.fn().mockRejectedValue(new Error(error)),
  };
}

function createExplicitFailureHook(name = 'explicit-fail-hook'): PostMergeHook {
  return {
    name,
    description: `A hook that returns success: false`,
    execute: vi.fn().mockResolvedValue({ success: false, message: 'Validation failed' }),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('PostMergeRunnerImpl', () => {
  let api: ReturnType<typeof createMockApi>;
  let runner: PostMergeRunnerImpl;

  beforeEach(() => {
    api = createMockApi();
    runner = new PostMergeRunnerImpl(api, {
      workspaceRoot: '/tmp/test-workspace',
      entityId: 'el-steward' as any,
    });
  });

  // --------------------------------------------------------------------------
  // Hook Registration
  // --------------------------------------------------------------------------

  describe('hook registration', () => {
    it('should register a hook', () => {
      const hook = createSuccessHook();
      runner.registerHook(hook);
      expect(runner.getHooks()).toHaveLength(1);
      expect(runner.getHooks()[0].name).toBe('success-hook');
    });

    it('should replace a hook with the same name', () => {
      const hook1 = createSuccessHook('my-hook');
      const hook2 = createSuccessHook('my-hook');
      runner.registerHook(hook1);
      runner.registerHook(hook2);
      expect(runner.getHooks()).toHaveLength(1);
    });

    it('should remove a hook by name', () => {
      runner.registerHook(createSuccessHook());
      expect(runner.removeHook('success-hook')).toBe(true);
      expect(runner.getHooks()).toHaveLength(0);
    });

    it('should return false when removing a non-existent hook', () => {
      expect(runner.removeHook('non-existent')).toBe(false);
    });

    it('should return hooks in registration order', () => {
      runner.registerHook(createSuccessHook('hook-a'));
      runner.registerHook(createSuccessHook('hook-b'));
      runner.registerHook(createSuccessHook('hook-c'));
      const names = runner.getHooks().map((h) => h.name);
      expect(names).toEqual(['hook-a', 'hook-b', 'hook-c']);
    });
  });

  // --------------------------------------------------------------------------
  // runAndRemediate — Success Cases
  // --------------------------------------------------------------------------

  describe('runAndRemediate — success', () => {
    it('should return success when no hooks are registered', async () => {
      const context = createMockContext();
      const result = await runner.runAndRemediate(context);

      expect(result.allSucceeded).toBe(true);
      expect(result.totalHooks).toBe(0);
      expect(result.successCount).toBe(0);
      expect(result.failureCount).toBe(0);
      expect(result.results).toHaveLength(0);
    });

    it('should run all hooks and report success', async () => {
      runner.registerHook(createSuccessHook('hook-1'));
      runner.registerHook(createSuccessHook('hook-2'));
      const context = createMockContext();

      const result = await runner.runAndRemediate(context);

      expect(result.allSucceeded).toBe(true);
      expect(result.totalHooks).toBe(2);
      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(0);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].success).toBe(true);
      expect(result.results[1].success).toBe(true);
    });

    it('should pass context to each hook', async () => {
      const hook = createSuccessHook();
      runner.registerHook(hook);
      const context = createMockContext({ commitSha: 'specific-sha-123' });

      await runner.runAndRemediate(context);

      expect(hook.execute).toHaveBeenCalledWith(context);
    });

    it('should not create remediation tasks when all hooks succeed', async () => {
      runner.registerHook(createSuccessHook());
      const context = createMockContext();

      await runner.runAndRemediate(context);

      expect(api.create).not.toHaveBeenCalled();
    });

    it('should include the merge context in the result', async () => {
      const context = createMockContext({ commitSha: 'my-sha' });
      const result = await runner.runAndRemediate(context);

      expect(result.context).toBe(context);
      expect(result.context.commitSha).toBe('my-sha');
    });

    it('should track duration for each hook', async () => {
      runner.registerHook(createSuccessHook());
      const context = createMockContext();

      const result = await runner.runAndRemediate(context);

      expect(result.results[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  // --------------------------------------------------------------------------
  // runAndRemediate — Failure & Remediation
  // --------------------------------------------------------------------------

  describe('runAndRemediate — failure & remediation', () => {
    it('should create a remediation task when a hook throws', async () => {
      runner.registerHook(createFailingHook('deploy-hook', 'Deploy failed'));
      const context = createMockContext();

      const result = await runner.runAndRemediate(context);

      expect(result.allSucceeded).toBe(false);
      expect(result.failureCount).toBe(1);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toBe('Deploy failed');
      expect(result.results[0].remediationTaskId).toBe('el-mock-task');

      // Verify task was created via api.create
      expect(api.create).toHaveBeenCalledTimes(1);
      const createdTask = api.create.mock.calls[0][0];
      expect(createdTask.title).toContain('deploy-hook');
      expect(createdTask.tags).toContain('post-merge-failure');
      expect(createdTask.tags).toContain('auto-created');
      expect(createdTask.priority).toBe(1); // High priority
    });

    it('should create a remediation task when hook returns success: false', async () => {
      runner.registerHook(createExplicitFailureHook());
      const context = createMockContext();

      const result = await runner.runAndRemediate(context);

      expect(result.allSucceeded).toBe(false);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].remediationTaskId).toBe('el-mock-task');
      expect(api.create).toHaveBeenCalledTimes(1);
    });

    it('should include commit SHA and changed files in task metadata', async () => {
      runner.registerHook(createFailingHook());
      const context = createMockContext({
        commitSha: 'sha-abc123',
        changedFiles: ['file1.ts', 'file2.ts'],
      });

      await runner.runAndRemediate(context);

      const createdTask = api.create.mock.calls[0][0];
      expect(createdTask.metadata.commitSha).toBe('sha-abc123');
      expect(createdTask.metadata.changedFiles).toEqual(['file1.ts', 'file2.ts']);
    });

    it('should include error details in task metadata', async () => {
      runner.registerHook(createFailingHook('my-hook', 'ENOENT: file not found'));
      const context = createMockContext();

      await runner.runAndRemediate(context);

      const createdTask = api.create.mock.calls[0][0];
      expect(createdTask.metadata.errorDetails).toBe('ENOENT: file not found');
    });

    it('should include source and target branch in task metadata', async () => {
      runner.registerHook(createFailingHook());
      const context = createMockContext({
        sourceBranch: 'feat/auth',
        targetBranch: 'main',
      });

      await runner.runAndRemediate(context);

      const createdTask = api.create.mock.calls[0][0];
      expect(createdTask.metadata.sourceBranch).toBe('feat/auth');
      expect(createdTask.metadata.targetBranch).toBe('main');
    });

    it('should continue running hooks after failure by default', async () => {
      const hook1 = createFailingHook('hook-1');
      const hook2 = createSuccessHook('hook-2');
      runner.registerHook(hook1);
      runner.registerHook(hook2);
      const context = createMockContext();

      const result = await runner.runAndRemediate(context);

      expect(result.results).toHaveLength(2);
      expect(result.results[0].success).toBe(false);
      expect(result.results[1].success).toBe(true);
      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(1);
      expect(hook2.execute).toHaveBeenCalled();
    });

    it('should stop after failure when continueOnFailure=false', async () => {
      const runner2 = new PostMergeRunnerImpl(api, {
        workspaceRoot: '/tmp/test',
        continueOnFailure: false,
      });
      const hook1 = createFailingHook('hook-1');
      const hook2 = createSuccessHook('hook-2');
      runner2.registerHook(hook1);
      runner2.registerHook(hook2);

      const result = await runner2.runAndRemediate(createMockContext());

      expect(result.results).toHaveLength(1);
      expect(result.results[0].success).toBe(false);
      expect(hook2.execute).not.toHaveBeenCalled();
    });

    it('should create separate remediation tasks for each failing hook', async () => {
      let taskCounter = 0;
      api.create.mockImplementation(() =>
        Promise.resolve({ id: `el-task-${++taskCounter}` })
      );

      runner.registerHook(createFailingHook('hook-a', 'Error A'));
      runner.registerHook(createSuccessHook('hook-b'));
      runner.registerHook(createFailingHook('hook-c', 'Error C'));

      const result = await runner.runAndRemediate(createMockContext());

      expect(result.failureCount).toBe(2);
      expect(result.successCount).toBe(1);
      expect(api.create).toHaveBeenCalledTimes(2);
      expect(result.results[0].remediationTaskId).toBe('el-task-1');
      expect(result.results[2].remediationTaskId).toBe('el-task-2');
    });

    it('should handle remediation task creation failure gracefully', async () => {
      api.create.mockRejectedValue(new Error('DB error'));
      runner.registerHook(createFailingHook());

      const result = await runner.runAndRemediate(createMockContext());

      // Hook failure is still recorded
      expect(result.allSucceeded).toBe(false);
      expect(result.results[0].success).toBe(false);
      // But no remediation task ID since creation failed
      expect(result.results[0].remediationTaskId).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // runAndRemediate — Timeout
  // --------------------------------------------------------------------------

  describe('runAndRemediate — timeout', () => {
    it('should timeout a slow hook', async () => {
      const runner2 = new PostMergeRunnerImpl(api, {
        workspaceRoot: '/tmp/test',
        hookTimeoutMs: 50,
      });
      const slowHook: PostMergeHook = {
        name: 'slow-hook',
        execute: () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 200)),
      };
      runner2.registerHook(slowHook);

      const result = await runner2.runAndRemediate(createMockContext());

      expect(result.allSucceeded).toBe(false);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toContain('timed out');
    });
  });

  // --------------------------------------------------------------------------
  // runAndRemediate — Hook returning void
  // --------------------------------------------------------------------------

  describe('runAndRemediate — void hook result', () => {
    it('should treat void return as success', async () => {
      const voidHook: PostMergeHook = {
        name: 'void-hook',
        execute: vi.fn().mockResolvedValue(undefined),
      };
      runner.registerHook(voidHook);

      const result = await runner.runAndRemediate(createMockContext());

      expect(result.allSucceeded).toBe(true);
      expect(result.results[0].success).toBe(true);
    });
  });
});
