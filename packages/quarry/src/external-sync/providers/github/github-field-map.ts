/**
 * GitHub Field Map Configuration
 *
 * Defines how Stoneforge task fields map to GitHub issue fields.
 * Used by the GitHubTaskAdapter and the shared task sync adapter utilities.
 *
 * Key mappings:
 * - Priority (1-5) -> labels with 'priority:' prefix
 * - TaskType (bug/feature/task/chore) -> labels with 'type:' prefix
 * - Status -> GitHub issue state ('open' or 'closed')
 * - Tags -> labels (user-managed, no prefix)
 * - Sync-managed labels use the 'sf:' prefix
 */

import type { TaskStatus, Priority, TaskTypeValue } from '@stoneforge/core';
import type { TaskSyncFieldMapConfig } from '../../adapters/task-sync-adapter.js';

// ============================================================================
// Priority Label Mapping
// ============================================================================

/**
 * Maps Stoneforge priority values (1-5) to GitHub label names.
 * These labels are prefixed with 'sf:' when pushed to GitHub to
 * distinguish sync-managed labels from user-created labels.
 */
export const GITHUB_PRIORITY_LABELS: Record<Priority, string> = {
  1: 'priority:critical',
  2: 'priority:high',
  3: 'priority:medium',
  4: 'priority:low',
  5: 'priority:minimal',
} as Record<Priority, string>;

// ============================================================================
// Task Type Label Mapping
// ============================================================================

/**
 * Maps Stoneforge task type values to GitHub label names.
 * These labels are prefixed with 'sf:' when pushed to GitHub.
 */
export const GITHUB_TASK_TYPE_LABELS: Record<TaskTypeValue, string> = {
  bug: 'type:bug',
  feature: 'type:feature',
  task: 'type:task',
  chore: 'type:chore',
} as Record<TaskTypeValue, string>;

// ============================================================================
// Sync Label Prefix
// ============================================================================

/**
 * Prefix for Stoneforge-managed labels on GitHub issues.
 * Labels with this prefix are created and managed by the sync system.
 * User labels without this prefix are preserved during sync.
 */
export const GITHUB_SYNC_LABEL_PREFIX = 'sf:';

// ============================================================================
// Status <-> State Mapping
// ============================================================================

/**
 * Maps Stoneforge TaskStatus to GitHub issue state.
 *
 * GitHub only supports two issue states: 'open' and 'closed'.
 * Most Stoneforge statuses map to 'open' since GitHub can't
 * distinguish between open, in_progress, review, blocked, etc.
 *
 * Mapping:
 * - open, in_progress, review, blocked, deferred, backlog -> 'open'
 * - closed, tombstone -> 'closed'
 */
export function statusToGitHubState(status: TaskStatus): 'open' | 'closed' {
  switch (status) {
    case 'closed':
    case 'tombstone':
      return 'closed';
    case 'open':
    case 'in_progress':
    case 'review':
    case 'blocked':
    case 'deferred':
    case 'backlog':
    default:
      return 'open';
  }
}

/**
 * Maps GitHub issue state back to Stoneforge TaskStatus.
 *
 * Since GitHub has only 'open' and 'closed', we can't infer
 * fine-grained statuses like 'in_progress' or 'review' from
 * the state alone. Labels could be used in the future for
 * more granular mapping.
 *
 * Mapping:
 * - 'open' -> 'open' (simple default)
 * - 'closed' -> 'closed'
 */
export function gitHubStateToStatus(
  state: 'open' | 'closed',
  _labels: string[]
): TaskStatus {
  switch (state) {
    case 'closed':
      return 'closed';
    case 'open':
    default:
      return 'open';
  }
}

// ============================================================================
// Combined Field Map Config
// ============================================================================

/**
 * Complete GitHub-specific field mapping configuration.
 *
 * Used by the shared task sync adapter utilities to convert between
 * Stoneforge tasks and GitHub issues (in both push and pull directions).
 */
export const GITHUB_FIELD_MAP_CONFIG: TaskSyncFieldMapConfig = {
  priorityLabels: GITHUB_PRIORITY_LABELS,
  taskTypeLabels: GITHUB_TASK_TYPE_LABELS,
  syncLabelPrefix: GITHUB_SYNC_LABEL_PREFIX,
  statusToState: statusToGitHubState,
  stateToStatus: gitHubStateToStatus,
};
