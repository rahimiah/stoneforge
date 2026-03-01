/**
 * Merge Request Provider
 *
 * Abstracts merge request creation so the orchestrator can work with different
 * hosting backends (GitHub, GitLab, local-only, etc.) or no remote at all.
 *
 * @module
 */

import type { Task } from '@stoneforge/core';

// ============================================================================
// Types
// ============================================================================

/**
 * Result returned after creating a merge request
 */
export interface MergeRequestResult {
  readonly url?: string;
  readonly id?: number;
  readonly provider: string;
}

/**
 * Options for creating a merge request
 */
export interface CreateMergeRequestOptions {
  readonly title: string;
  readonly body: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
}

/**
 * Interface that all merge-request backends must implement
 */
export interface MergeRequestProvider {
  readonly name: string;
  createMergeRequest(task: Task, options: CreateMergeRequestOptions): Promise<MergeRequestResult>;
}

export interface GitHubCheck {
  readonly name: string;
  readonly state?: string;
  readonly conclusion?: string;
}

export interface WaitForChecksResult {
  readonly status: 'pending' | 'passed' | 'failed';
  readonly checks: readonly GitHubCheck[];
  readonly failingChecks: readonly GitHubCheck[];
}

export interface MergeViaPrOptions {
  readonly deleteBranch?: boolean;
}

// ============================================================================
// LocalMergeProvider — no-op provider for offline / local-only workflows
// ============================================================================

/**
 * A no-op provider that skips remote merge request creation.
 * Useful when running without a remote (e.g. local dev, CI dry-runs).
 */
export class LocalMergeProvider implements MergeRequestProvider {
  readonly name = 'local';

  async createMergeRequest(_task: Task, _options: CreateMergeRequestOptions): Promise<MergeRequestResult> {
    return { provider: this.name };
  }
}

// ============================================================================
// GitHubMergeProvider — creates pull requests via the `gh` CLI
// ============================================================================

/**
 * Creates and manages GitHub pull requests using the `gh` CLI tool.
 */
export class GitHubMergeProvider implements MergeRequestProvider {
  readonly name = 'github-pr';

  async assertCliReady(): Promise<void> {
    await this.runGh(['--version'], 'gh CLI is not installed or not on PATH');
    await this.runGh(
      ['auth', 'status'],
      'gh CLI is not authenticated. Run "gh auth login" before starting the server.'
    );
  }

  async createMergeRequest(task: Task, options: CreateMergeRequestOptions): Promise<MergeRequestResult> {
    const title = options.title || task.title;
    const body = options.body || this.buildDefaultBody(task);

    const { stdout } = await this.runGh([
      'pr', 'create',
      '--title', title,
      '--body', body,
      '--head', options.sourceBranch,
      '--base', options.targetBranch,
    ], 'gh pr create failed');

    const trimmedOutput = stdout.trim();
    const match = trimmedOutput.match(/\/pull\/(\d+)(?:\D.*)?$/);
    const prNumber = match ? parseInt(match[1], 10) : undefined;
    return { url: trimmedOutput || undefined, id: prNumber, provider: this.name };
  }

  async waitForChecks(identifier: number | string, requiredChecks: readonly string[] = []): Promise<WaitForChecksResult> {
    const { stdout } = await this.runGh(
      ['pr', 'checks', String(identifier), '--json', 'name,state,conclusion'],
      'gh pr checks failed'
    );

    const parsed = JSON.parse(stdout) as unknown;
    const checks = Array.isArray(parsed)
      ? parsed
          .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
          .map((item) => ({
            name: String(item.name ?? ''),
            state: typeof item.state === 'string' ? item.state : undefined,
            conclusion: typeof item.conclusion === 'string' ? item.conclusion : undefined,
          }))
      : [];

    const applicableChecks = requiredChecks.length > 0
      ? checks.filter((check) => requiredChecks.includes(check.name))
      : checks;

    const failingChecks = applicableChecks.filter((check) => {
      const normalized = (check.conclusion ?? check.state ?? '').toLowerCase();
      return normalized === 'failure' || normalized === 'failed' || normalized === 'timed_out' || normalized === 'cancelled' || normalized === 'action_required';
    });

    if (failingChecks.length > 0) {
      return { status: 'failed', checks: applicableChecks, failingChecks };
    }

    const pending = applicableChecks.some((check) => {
      const normalized = (check.conclusion ?? check.state ?? '').toLowerCase();
      return normalized === '' || normalized === 'queued' || normalized === 'in_progress' || normalized === 'pending' || normalized === 'waiting' || normalized === 'requested';
    });

    if (pending) {
      return { status: 'pending', checks: applicableChecks, failingChecks: [] };
    }

    return { status: 'passed', checks: applicableChecks, failingChecks: [] };
  }

  async mergeViaPr(identifier: number | string, options: MergeViaPrOptions = {}): Promise<void> {
    const args = ['pr', 'merge', String(identifier), '--squash'];
    if (options.deleteBranch !== false) {
      args.push('--delete-branch');
    }

    await this.runGh(args, 'gh pr merge failed');
  }

  private async runGh(args: string[], prefix: string): Promise<{ stdout: string; stderr: string }> {
    const { spawn } = await import('node:child_process');

    return new Promise((resolve, reject) => {
      const proc = spawn('gh', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code: number | null) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`${prefix} (code ${code}): ${stderr || stdout}`));
        }
      });

      proc.on('error', (err: Error) => {
        reject(new Error(`${prefix}: ${err.message}`));
      });
    });
  }

  private buildDefaultBody(task: Task): string {
    return `## Task\n\n**ID:** ${task.id}\n**Title:** ${task.title}\n\n---\n_Created by Stoneforge Smithy_`;
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates a LocalMergeProvider (the default, no-remote provider)
 */
export function createLocalMergeProvider(): MergeRequestProvider {
  return new LocalMergeProvider();
}

/**
 * Creates a GitHubMergeProvider that uses the `gh` CLI
 */
export function createGitHubMergeProvider(): GitHubMergeProvider {
  return new GitHubMergeProvider();
}
