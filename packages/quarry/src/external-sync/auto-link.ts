/**
 * Auto-Link Utility
 *
 * Creates an external issue on a configured provider and links it back to
 * a Stoneforge task via `externalRef` and `_externalSync` metadata.
 *
 * Designed to be called after task creation in a fire-and-forget pattern.
 * Never throws — all errors are caught and returned as `{ success: false, error }`.
 */

import type {
  Task,
  ExternalProvider,
  ExternalSyncState,
  SyncDirection,
  ElementId,
} from '@stoneforge/core';
import type { QuarryAPI } from '../api/types.js';

const LOG_PREFIX = '[external-sync]';

// ============================================================================
// Types
// ============================================================================

/**
 * Parameters for autoLinkTask()
 */
export interface AutoLinkTaskParams {
  /** The newly created task to auto-link */
  task: Task;
  /** QuarryAPI instance for updating the task */
  api: QuarryAPI;
  /** Configured external provider instance (e.g., GitHub, Linear) */
  provider: ExternalProvider;
  /** Project identifier (e.g., 'owner/repo' for GitHub, team key for Linear) */
  project: string;
  /** Sync direction to set on the link */
  direction: SyncDirection;
}

/**
 * Result of autoLinkTask()
 */
export interface AutoLinkTaskResult {
  /** Whether the auto-link succeeded */
  success: boolean;
  /** The ExternalSyncState set on the task (only on success) */
  syncState?: ExternalSyncState;
  /** Error message (only on failure) */
  error?: string;
}

// ============================================================================
// Auto-Link Function
// ============================================================================

/**
 * Auto-link a newly created task to an external issue.
 *
 * Creates an issue on the configured provider and updates the Stoneforge task
 * with `externalRef` and `_externalSync` metadata.
 *
 * **Never throws** — catches all errors and returns `{ success: false, error }`.
 * Auto-link failure must not prevent task creation.
 *
 * @param params - The auto-link parameters
 * @returns Result indicating success or failure with details
 *
 * @example
 * ```typescript
 * const result = await autoLinkTask({
 *   task,
 *   api,
 *   provider: githubProvider,
 *   project: 'owner/repo',
 *   direction: 'bidirectional',
 * });
 *
 * if (!result.success) {
 *   console.warn('Auto-link failed:', result.error);
 * }
 * ```
 */
export async function autoLinkTask(params: AutoLinkTaskParams): Promise<AutoLinkTaskResult> {
  const { task, api, provider, project, direction } = params;

  try {
    // 1. Get the provider's task adapter
    const adapter = provider.getTaskAdapter?.();
    if (!adapter) {
      const message = `Provider '${provider.name}' does not support task sync`;
      console.warn(`${LOG_PREFIX} Auto-link failed for task ${task.id}: ${message}`);
      return { success: false, error: message };
    }

    // 2. Create the external issue
    const externalTask = await adapter.createIssue(project, {
      title: task.title,
      body: task.descriptionRef ? `Stoneforge task: ${task.id}` : undefined,
      labels: task.tags ? [...task.tags] : undefined,
    });

    // 3. Build the ExternalSyncState metadata
    const syncState: ExternalSyncState = {
      provider: provider.name,
      project,
      externalId: externalTask.externalId,
      url: externalTask.url,
      direction,
      adapterType: 'task',
    };

    // 4. Update the task with externalRef and _externalSync metadata
    const existingMetadata = (task.metadata ?? {}) as Record<string, unknown>;
    await api.update<Task>(task.id as unknown as ElementId, {
      externalRef: externalTask.url,
      metadata: {
        ...existingMetadata,
        _externalSync: syncState,
      },
    } as Partial<Task>);

    console.info(
      `${LOG_PREFIX} Auto-linked task ${task.id} to ${provider.name} issue ${externalTask.externalId} (${externalTask.url})`
    );

    // 5. Return success
    return { success: true, syncState };
  } catch (err) {
    // 6. Never throw — catch all errors and return failure
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG_PREFIX} Auto-link failed for task ${task.id}: ${message}`);
    return { success: false, error: message };
  }
}
