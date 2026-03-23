/**
 * Post-Merge Runner Service
 *
 * Executes registered post-merge hooks after a successful merge and
 * auto-creates remediation tasks when any hook fails. This provides
 * a safety net: if a post-merge hook (e.g. release notes, changelog
 * generation, deploy trigger) fails, a high-priority task is
 * automatically created with full failure context so the issue can
 * be addressed quickly.
 *
 * @module
 */

import type { Task, ElementId, EntityId } from '@stoneforge/core';
import { TaskStatus, createTask } from '@stoneforge/core';
import type { QuarryAPI } from '@stoneforge/quarry';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('post-merge-runner');

// ============================================================================
// Types
// ============================================================================

/**
 * A post-merge hook that can be registered with the runner.
 */
export interface PostMergeHook {
  /** Unique name for this hook (used in error reports) */
  readonly name: string;
  /** Human-readable description of what this hook does */
  readonly description?: string;
  /**
   * Execute the hook.
   *
   * @param context - Merge context including commit SHA, changed files, etc.
   * @returns A result object, or void if the hook has no meaningful return value.
   * @throws If the hook fails — the error will be caught and a remediation task created.
   */
  execute(context: PostMergeContext): Promise<PostMergeHookResult | void>;
}

/**
 * Context passed to each post-merge hook with details about the merge.
 */
export interface PostMergeContext {
  /** SHA of the merge commit */
  readonly commitSha: string;
  /** Files changed in the merge */
  readonly changedFiles: readonly string[];
  /** The source branch that was merged */
  readonly sourceBranch: string;
  /** The target branch merged into */
  readonly targetBranch: string;
  /** Workspace root directory */
  readonly workspaceRoot: string;
  /** The original task ID that triggered the merge, if available */
  readonly taskId?: ElementId;
}

/**
 * Result returned by a successful hook execution.
 */
export interface PostMergeHookResult {
  /** Whether the hook completed successfully */
  readonly success: boolean;
  /** Optional message from the hook */
  readonly message?: string;
}

/**
 * Backward-compatible alias for the public hook result contract.
 */
export type HookResult = PostMergeHookResult;

/**
 * Result of a single hook execution within runAndRemediate.
 */
export interface HookExecutionResult {
  /** Name of the hook */
  readonly hookName: string;
  /** Whether the hook succeeded */
  readonly success: boolean;
  /** Hook result if it returned one */
  readonly result?: PostMergeHookResult;
  /** Error message if the hook failed */
  readonly error?: string;
  /** Duration of hook execution in ms */
  readonly durationMs: number;
  /** ID of the remediation task created on failure, if any */
  readonly remediationTaskId?: ElementId;
}

/**
 * Result of running all hooks via runAndRemediate.
 */
export interface RunAndRemediateResult {
  /** Whether all hooks succeeded */
  readonly allSucceeded: boolean;
  /** Total number of hooks executed */
  readonly totalHooks: number;
  /** Number of hooks that succeeded */
  readonly successCount: number;
  /** Number of hooks that failed */
  readonly failureCount: number;
  /** Individual hook results */
  readonly results: readonly HookExecutionResult[];
  /** The merge context that was used */
  readonly context: PostMergeContext;
  /** Total duration in ms */
  readonly durationMs: number;
}

/**
 * Configuration for the PostMergeRunner.
 */
export interface PostMergeRunnerConfig {
  /** Workspace root directory */
  readonly workspaceRoot: string;
  /** Entity ID for the runner (used as createdBy on remediation tasks) */
  readonly entityId?: EntityId;
  /** Whether to continue running hooks after a failure (default: true) */
  readonly continueOnFailure?: boolean;
  /** Timeout per hook in ms (default: 60000 — 1 minute) */
  readonly hookTimeoutMs?: number;
}

// ============================================================================
// PostMergeRunner Interface
// ============================================================================

/**
 * PostMergeRunner manages post-merge hooks and provides auto-remediation
 * when hooks fail.
 */
export interface PostMergeRunner {
  /**
   * Register a hook to be executed after merges.
   */
  registerHook(hook: PostMergeHook): void;

  /**
   * Remove a registered hook by name.
   */
  removeHook(name: string): boolean;

  /**
   * Get all registered hooks.
   */
  getHooks(): readonly PostMergeHook[];

  /**
   * Run all registered hooks and auto-create remediation tasks for any
   * that fail. Each failure produces a high-priority task with failure
   * details, commit SHA, and changed files.
   *
   * @param context - The post-merge context (commit SHA, changed files, etc.)
   * @returns Result with per-hook outcomes and any created remediation task IDs.
   */
  runAndRemediate(context: PostMergeContext): Promise<RunAndRemediateResult>;
}

// ============================================================================
// Implementation
// ============================================================================

export class PostMergeRunnerImpl implements PostMergeRunner {
  private readonly hooks: Map<string, PostMergeHook> = new Map();
  private readonly api: QuarryAPI;
  private readonly config: PostMergeRunnerConfig;

  constructor(api: QuarryAPI, config: PostMergeRunnerConfig) {
    this.api = api;
    this.config = config;
  }

  registerHook(hook: PostMergeHook): void {
    if (this.hooks.has(hook.name)) {
      logger.warn(`Replacing existing hook: ${hook.name}`);
    }
    this.hooks.set(hook.name, hook);
    logger.info(`Registered post-merge hook: ${hook.name}`);
  }

  removeHook(name: string): boolean {
    const removed = this.hooks.delete(name);
    if (removed) {
      logger.info(`Removed post-merge hook: ${name}`);
    }
    return removed;
  }

  getHooks(): readonly PostMergeHook[] {
    return Array.from(this.hooks.values());
  }

  async runAndRemediate(context: PostMergeContext): Promise<RunAndRemediateResult> {
    const startTime = Date.now();
    const hooks = this.getHooks();
    const continueOnFailure = this.config.continueOnFailure ?? true;
    const hookTimeoutMs = this.config.hookTimeoutMs ?? 60_000;
    const results: HookExecutionResult[] = [];

    logger.info(
      `Running ${hooks.length} post-merge hook(s) for commit ${context.commitSha.slice(0, 8)} ` +
      `(${context.sourceBranch} → ${context.targetBranch})`
    );

    for (const hook of hooks) {
      const hookStart = Date.now();
      let result: HookExecutionResult;

      try {
        // Execute hook with timeout
        const hookResult = await Promise.race([
          hook.execute(context),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Hook '${hook.name}' timed out after ${hookTimeoutMs}ms`)),
              hookTimeoutMs
            )
          ),
        ]);

        // Check if hook returned an explicit failure
        if (hookResult && !hookResult.success) {
          result = {
            hookName: hook.name,
            success: false,
            result: hookResult,
            error: hookResult.message ?? 'Hook returned success: false',
            durationMs: Date.now() - hookStart,
          };
        } else {
          result = {
            hookName: hook.name,
            success: true,
            result: hookResult ?? undefined,
            durationMs: Date.now() - hookStart,
          };
          logger.info(`Hook '${hook.name}' succeeded (${result.durationMs}ms)`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        result = {
          hookName: hook.name,
          success: false,
          error: errorMessage,
          durationMs: Date.now() - hookStart,
        };
        logger.error(`Hook '${hook.name}' failed: ${errorMessage}`);
      }

      // If the hook failed, create a remediation task
      if (!result.success) {
        try {
          const taskId = await this.createRemediationTask(hook, context, result.error ?? 'Unknown error');
          result = { ...result, remediationTaskId: taskId };
          logger.info(`Created remediation task ${taskId} for failed hook '${hook.name}'`);
        } catch (taskError) {
          const taskErrorMsg = taskError instanceof Error ? taskError.message : String(taskError);
          logger.error(`Failed to create remediation task for hook '${hook.name}': ${taskErrorMsg}`);
        }
      }

      results.push(result);

      // Stop early if configured to not continue on failure
      if (!result.success && !continueOnFailure) {
        logger.warn(`Stopping hook execution after failure in '${hook.name}' (continueOnFailure=false)`);
        break;
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.filter((r) => !r.success).length;
    const totalDuration = Date.now() - startTime;

    logger.info(
      `Post-merge hooks complete: ${successCount}/${hooks.length} succeeded, ` +
      `${failureCount} failed (${totalDuration}ms total)`
    );

    return {
      allSucceeded: failureCount === 0,
      totalHooks: hooks.length,
      successCount,
      failureCount,
      results,
      context,
      durationMs: totalDuration,
    };
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Create a high-priority remediation task for a failed post-merge hook.
   */
  private async createRemediationTask(
    hook: PostMergeHook,
    context: PostMergeContext,
    errorDetails: string
  ): Promise<ElementId> {
    const title = `Fix post-merge hook failure: ${hook.name}`;

    const descriptionLines = [
      `A post-merge hook failed and requires manual remediation.`,
      '',
      '## Hook Details',
      `- **Hook name:** ${hook.name}`,
      ...(hook.description ? [`- **Description:** ${hook.description}`] : []),
      '',
      '## Merge Context',
      `- **Commit SHA:** ${context.commitSha}`,
      `- **Source branch:** ${context.sourceBranch}`,
      `- **Target branch:** ${context.targetBranch}`,
      ...(context.taskId ? [`- **Original task:** ${context.taskId}`] : []),
      '',
      '## Error Details',
      '```',
      errorDetails,
      '```',
    ];

    if (context.changedFiles.length > 0) {
      descriptionLines.push(
        '',
        '## Changed Files',
        ...context.changedFiles.map((f) => `- ${f}`)
      );
    }

    descriptionLines.push(
      '',
      '## Instructions',
      '1. Investigate the hook failure using the error details above',
      '2. Fix the underlying issue',
      `3. Re-run the hook manually if needed: \`${hook.name}\``,
      '4. Close this task when resolved',
    );

    const createdBy = this.config.entityId ?? ('el-0000' as EntityId);
    const taskData = await createTask({
      title,
      status: TaskStatus.OPEN,
      tags: ['post-merge-failure', 'auto-created'],
      priority: 1, // High priority
      createdBy,
      metadata: {
        description: descriptionLines.join('\n'),
        hookName: hook.name,
        commitSha: context.commitSha,
        sourceBranch: context.sourceBranch,
        targetBranch: context.targetBranch,
        changedFiles: context.changedFiles,
        originalTaskId: context.taskId,
        errorDetails,
      },
    });

    const task = await this.api.create<Task>(
      taskData as unknown as Record<string, unknown> & { createdBy: EntityId }
    );

    return task.id;
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a new PostMergeRunner instance.
 */
export function createPostMergeRunner(
  api: QuarryAPI,
  config: PostMergeRunnerConfig
): PostMergeRunner {
  return new PostMergeRunnerImpl(api, config);
}
