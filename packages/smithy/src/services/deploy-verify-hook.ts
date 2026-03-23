import { spawn } from 'node:child_process';
import type { PostMergeContext, PostMergeHook, PostMergeHookResult } from './post-merge-runner.js';

export type DeployVerificationStatus = 'pass' | 'fail' | 'pending';

export interface GitHubWorkflowRun {
  readonly databaseId?: number;
  readonly workflowName?: string;
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string;
  readonly url?: string;
  readonly headSha?: string;
}

export interface DeployVerifyHookResult extends PostMergeHookResult {
  readonly status: DeployVerificationStatus;
  readonly runs: readonly GitHubWorkflowRun[];
  readonly attempts: number;
  readonly elapsedMs: number;
}

export interface DeployVerifyHookConfig {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly repo?: string;
  readonly runGh?: (args: readonly string[], context: PostMergeContext) => Promise<string>;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

const SUCCESS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const FAILURE_OUTCOMES = new Set([
  'failure',
  'failed',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
  'stale',
]);
const PENDING_OUTCOMES = new Set([
  'queued',
  'in_progress',
  'pending',
  'waiting',
  'requested',
]);

function normalizeState(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function formatRun(run: GitHubWorkflowRun): string {
  const name = run.workflowName || run.name || `run ${run.databaseId ?? 'unknown'}`;
  const status = normalizeState(run.status) || 'unknown';
  const conclusion = normalizeState(run.conclusion);

  return conclusion ? `${name} (${status}/${conclusion})` : `${name} (${status})`;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultRunGh(args: readonly string[], context: PostMergeContext): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('gh', [...args], {
      cwd: context.workspaceRoot,
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
        resolve(stdout);
        return;
      }

      reject(new Error(`gh run list failed (code ${code}): ${stderr || stdout}`));
    });

    proc.on('error', (error: Error) => {
      reject(new Error(`gh run list failed: ${error.message}`));
    });
  });
}

export class DeployVerifyHook implements PostMergeHook {
  readonly name = 'deploy-verification';
  readonly description = 'Polls GitHub Actions workflow runs for the merge commit until CI passes, fails, or times out.';

  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly repo?: string;
  private readonly runGh: (args: readonly string[], context: PostMergeContext) => Promise<string>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: DeployVerifyHookConfig = {}) {
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.repo = config.repo;
    this.runGh = config.runGh ?? defaultRunGh;
    this.sleep = config.sleep ?? defaultSleep;
  }

  async execute(context: PostMergeContext): Promise<DeployVerifyHookResult> {
    const result = await this.verify(context);
    return {
      success: result.status === 'pass',
      message: result.message,
      status: result.status,
      runs: result.runs,
      attempts: result.attempts,
      elapsedMs: result.elapsedMs,
    };
  }

  async verify(context: PostMergeContext): Promise<DeployVerifyHookResult> {
    const startedAt = Date.now();
    let attempts = 0;

    while (true) {
      attempts += 1;
      const runs = await this.fetchWorkflowRuns(context);
      const status = this.classifyRuns(runs);
      const elapsedMs = Date.now() - startedAt;

      if (status === 'pass') {
        return {
          success: true,
          status,
          message: `GitHub Actions passed for commit ${context.commitSha}.`,
          runs,
          attempts,
          elapsedMs,
        };
      }

      if (status === 'fail') {
        return {
          success: false,
          status,
          message: `GitHub Actions failed for commit ${context.commitSha}: ${runs.map(formatRun).join(', ')}`,
          runs,
          attempts,
          elapsedMs,
        };
      }

      if (elapsedMs >= this.timeoutMs) {
        const summary = runs.length > 0
          ? runs.map(formatRun).join(', ')
          : 'no workflow runs found';

        return {
          success: false,
          status: 'pending',
          message: `GitHub Actions still pending for commit ${context.commitSha} after ${elapsedMs}ms: ${summary}`,
          runs,
          attempts,
          elapsedMs,
        };
      }

      await this.sleep(this.pollIntervalMs);
    }
  }

  private classifyRuns(runs: readonly GitHubWorkflowRun[]): DeployVerificationStatus {
    if (runs.length === 0) {
      return 'pending';
    }

    if (runs.some((run) => {
      const status = normalizeState(run.status);
      const conclusion = normalizeState(run.conclusion);
      return FAILURE_OUTCOMES.has(conclusion) || FAILURE_OUTCOMES.has(status);
    })) {
      return 'fail';
    }

    if (runs.some((run) => {
      const status = normalizeState(run.status);
      const conclusion = normalizeState(run.conclusion);
      if (PENDING_OUTCOMES.has(status) || PENDING_OUTCOMES.has(conclusion)) {
        return true;
      }
      if (status !== 'completed') {
        return conclusion === '';
      }
      return !SUCCESS_CONCLUSIONS.has(conclusion);
    })) {
      return 'pending';
    }

    return 'pass';
  }

  private async fetchWorkflowRuns(context: PostMergeContext): Promise<GitHubWorkflowRun[]> {
    const args = [
      'run',
      'list',
      '--commit',
      context.commitSha,
      '--json',
      'databaseId,workflowName,name,status,conclusion,url,headSha',
      '--limit',
      '100',
    ];

    if (this.repo) {
      args.push('--repo', this.repo);
    }

    const output = await this.runGh(args, context);
    const parsed = JSON.parse(output) as unknown;

    if (!Array.isArray(parsed)) {
      throw new Error('gh run list returned non-array JSON');
    }

    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        databaseId: typeof item.databaseId === 'number' ? item.databaseId : undefined,
        workflowName: typeof item.workflowName === 'string' ? item.workflowName : undefined,
        name: typeof item.name === 'string' ? item.name : undefined,
        status: typeof item.status === 'string' ? item.status : undefined,
        conclusion: typeof item.conclusion === 'string' ? item.conclusion : undefined,
        url: typeof item.url === 'string' ? item.url : undefined,
        headSha: typeof item.headSha === 'string' ? item.headSha : undefined,
      }))
      .filter((run) => run.headSha === undefined || run.headSha === context.commitSha);
  }
}

export function createDeployVerifyHook(config: DeployVerifyHookConfig = {}): DeployVerifyHook {
  return new DeployVerifyHook(config);
}
