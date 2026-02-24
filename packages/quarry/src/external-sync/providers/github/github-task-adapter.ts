/**
 * GitHub Task Sync Adapter
 *
 * Implements TaskSyncAdapter for GitHub Issues.
 * Uses GitHubApiClient internally for all API operations and maps between
 * the normalized ExternalTask format and GitHub's issue representation.
 *
 * Project format: 'owner/repo' (e.g., 'stoneforge-ai/stoneforge')
 * External ID format: issue number as string (e.g., '42')
 */

import type {
  TaskSyncAdapter,
  ExternalTask,
  ExternalTaskInput,
  TaskFieldMapConfig,
} from '@stoneforge/core';
import type { Timestamp } from '@stoneforge/core';
import { GitHubApiClient, isGitHubApiError } from './github-api.js';
import type { GitHubApiClientOptions, GitHubIssue } from './github-api.js';
import { GITHUB_FIELD_MAP_CONFIG } from './github-field-map.js';

// ============================================================================
// Project Parsing
// ============================================================================

/**
 * Parses a project string in 'owner/repo' format into owner and repo components.
 *
 * @param project - Project identifier in 'owner/repo' format
 * @returns Tuple of [owner, repo]
 * @throws Error if the project string is not in the expected format
 */
function parseProject(project: string): [string, string] {
  const parts = project.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid GitHub project format: '${project}'. Expected 'owner/repo' (e.g., 'stoneforge-ai/stoneforge').`
    );
  }
  return [parts[0], parts[1]];
}

// ============================================================================
// GitHub Issue <-> ExternalTask Mapping
// ============================================================================

/**
 * Converts a GitHub API issue response to the normalized ExternalTask format.
 *
 * @param issue - Raw GitHub issue from the API client
 * @param project - The 'owner/repo' project identifier
 * @returns Normalized ExternalTask
 */
function githubIssueToExternalTask(issue: GitHubIssue, project: string): ExternalTask {
  return {
    externalId: String(issue.number),
    url: issue.html_url,
    provider: 'github',
    project,
    title: issue.title,
    body: issue.body ?? undefined,
    state: issue.state,
    labels: issue.labels.map((label) => label.name),
    assignees: issue.assignees.map((user) => user.login),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at ?? undefined,
    raw: issue as unknown as Record<string, unknown>,
  };
}

// ============================================================================
// GitHubTaskAdapter
// ============================================================================

/**
 * TaskSyncAdapter implementation for GitHub Issues.
 *
 * Maps between Stoneforge's normalized ExternalTask format and GitHub's
 * issue API. Uses GitHubApiClient for all HTTP operations.
 *
 * Usage:
 * ```typescript
 * const adapter = new GitHubTaskAdapter({
 *   token: 'ghp_...',
 *   apiBaseUrl: 'https://api.github.com', // optional
 * });
 *
 * const issue = await adapter.getIssue('owner/repo', '42');
 * const issues = await adapter.listIssuesSince('owner/repo', Date.now());
 * ```
 */
export class GitHubTaskAdapter implements TaskSyncAdapter {
  private readonly client: GitHubApiClient;

  constructor(options: GitHubApiClientOptions) {
    this.client = new GitHubApiClient(options);
  }

  /**
   * Fetch a single issue by its number.
   *
   * @param project - Repository in 'owner/repo' format
   * @param externalId - GitHub issue number as a string
   * @returns The normalized ExternalTask, or null if not found
   */
  async getIssue(project: string, externalId: string): Promise<ExternalTask | null> {
    const [owner, repo] = parseProject(project);
    const issueNumber = parseInt(externalId, 10);

    if (isNaN(issueNumber) || issueNumber <= 0) {
      throw new Error(
        `Invalid GitHub issue number: '${externalId}'. Expected a positive integer.`
      );
    }

    try {
      const issue = await this.client.getIssue(owner, repo, issueNumber);
      return githubIssueToExternalTask(issue, project);
    } catch (error) {
      // Return null for 404 (issue not found), rethrow other errors
      if (isGitHubApiError(error) && error.isNotFound) {
        return null;
      }
      throw error;
    }
  }

  /**
   * List all issues updated since the given timestamp.
   *
   * Fetches all issues (open and closed) that have been updated since
   * the provided timestamp. Uses auto-pagination to retrieve all matching
   * issues across multiple pages.
   *
   * @param project - Repository in 'owner/repo' format
   * @param since - Timestamp (milliseconds since epoch) to filter by
   * @returns Array of normalized ExternalTask objects
   */
  async listIssuesSince(project: string, since: Timestamp): Promise<ExternalTask[]> {
    const [owner, repo] = parseProject(project);

    // Convert Timestamp (ms since epoch) to ISO 8601 string
    const sinceISO = new Date(since).toISOString();

    const issues = await this.client.listIssues(owner, repo, {
      since: sinceISO,
      state: 'all',
      per_page: 100,
    });

    return issues.map((issue) => githubIssueToExternalTask(issue, project));
  }

  /**
   * Create a new issue in the specified repository.
   *
   * Maps ExternalTaskInput fields to GitHub's create issue payload:
   * - title -> title
   * - body -> body
   * - labels -> labels (as label names)
   * - assignees -> assignees (as usernames)
   *
   * Note: The 'state' field from ExternalTaskInput is ignored for creation
   * since GitHub issues are always created in the 'open' state.
   *
   * @param project - Repository in 'owner/repo' format
   * @param issue - The issue data to create
   * @returns The created ExternalTask with its new external ID and URL
   */
  async createIssue(project: string, issue: ExternalTaskInput): Promise<ExternalTask> {
    const [owner, repo] = parseProject(project);

    const created = await this.client.createIssue(owner, repo, {
      title: issue.title,
      body: issue.body,
      labels: issue.labels ? [...issue.labels] : undefined,
      assignees: issue.assignees ? [...issue.assignees] : undefined,
    });

    return githubIssueToExternalTask(created, project);
  }

  /**
   * Update an existing issue in the specified repository.
   *
   * Maps partial ExternalTaskInput fields to GitHub's update issue payload.
   * Only fields present in the updates object are sent to GitHub —
   * undefined fields are left unchanged.
   *
   * @param project - Repository in 'owner/repo' format
   * @param externalId - GitHub issue number as a string
   * @param updates - Partial issue data to update
   * @returns The updated ExternalTask
   */
  async updateIssue(
    project: string,
    externalId: string,
    updates: Partial<ExternalTaskInput>
  ): Promise<ExternalTask> {
    const [owner, repo] = parseProject(project);
    const issueNumber = parseInt(externalId, 10);

    if (isNaN(issueNumber) || issueNumber <= 0) {
      throw new Error(
        `Invalid GitHub issue number: '${externalId}'. Expected a positive integer.`
      );
    }

    // Build the update payload, only including defined fields
    const payload: Record<string, unknown> = {};

    if (updates.title !== undefined) {
      payload.title = updates.title;
    }
    if (updates.body !== undefined) {
      payload.body = updates.body;
    }
    if (updates.state !== undefined) {
      payload.state = updates.state;
    }
    if (updates.labels !== undefined) {
      payload.labels = [...updates.labels];
    }
    if (updates.assignees !== undefined) {
      payload.assignees = [...updates.assignees];
    }

    const updated = await this.client.updateIssue(owner, repo, issueNumber, payload);

    return githubIssueToExternalTask(updated, project);
  }

  /**
   * Returns the GitHub-specific field mapping configuration.
   *
   * This configuration is used by the shared task sync adapter utilities
   * to map between Stoneforge task fields and GitHub issue fields.
   *
   * The returned TaskFieldMapConfig describes individual field mappings
   * with their directions and transform function names.
   *
   * @returns TaskFieldMapConfig for GitHub
   */
  getFieldMapConfig(): TaskFieldMapConfig {
    return {
      provider: 'github',
      fields: [
        {
          localField: 'title',
          externalField: 'title',
          direction: 'bidirectional',
        },
        {
          localField: 'descriptionRef',
          externalField: 'body',
          direction: 'bidirectional',
          toExternal: 'hydrateDescription',
          toLocal: 'createDescriptionDoc',
        },
        {
          localField: 'status',
          externalField: 'state',
          direction: 'bidirectional',
          toExternal: 'statusToGitHubState',
          toLocal: 'gitHubStateToStatus',
        },
        {
          localField: 'tags',
          externalField: 'labels',
          direction: 'bidirectional',
        },
        {
          localField: 'priority',
          externalField: 'labels',
          direction: 'bidirectional',
          toExternal: 'priorityToLabel',
          toLocal: 'labelToPriority',
        },
        {
          localField: 'taskType',
          externalField: 'labels',
          direction: 'bidirectional',
          toExternal: 'taskTypeToLabel',
          toLocal: 'labelToTaskType',
        },
        {
          localField: 'assignee',
          externalField: 'assignees',
          direction: 'bidirectional',
        },
      ],
    };
  }
}

/**
 * Returns the GitHub-specific TaskSyncFieldMapConfig for use with
 * the shared task sync adapter utilities.
 *
 * This is a convenience export for code that needs the config directly
 * without going through the adapter's getFieldMapConfig() method.
 */
export { GITHUB_FIELD_MAP_CONFIG } from './github-field-map.js';
