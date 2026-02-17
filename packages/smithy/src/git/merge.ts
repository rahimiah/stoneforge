/**
 * Git Merge Utilities
 *
 * Shared squash-merge-in-temp-worktree logic used by both the Merge Steward
 * and the Docs Steward services.
 *
 * Pattern:
 *  1. Fetch origin (skipped when local-only / no remote)
 *  2. (Optional) Pre-flight conflict detection via git merge-tree
 *  3. Create temp worktree with detached HEAD at origin/<target> or local <target>
 *  4. Squash merge (or regular merge) source branch
 *  5. Commit with provided message
 *  6. Push HEAD:<target> to remote (skipped when local-only)
 *  7. Remove temp worktree (always, in finally)
 *  8. (Optional) Sync local target branch via fast-forward
 *
 * Local-only mode is auto-detected when no 'origin' remote exists, or can
 * be forced via the `localOnly` option in MergeBranchOptions.
 *
 * @module
 */

import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// ============================================================================
// Types
// ============================================================================

export interface MergeBranchOptions {
  /** Workspace root (the main repo checkout) */
  workspaceRoot: string;
  /** Branch to merge from */
  sourceBranch: string;
  /** Branch to merge into (auto-detected if omitted) */
  targetBranch?: string;
  /** 'squash' (default) or 'merge' (--no-ff) */
  mergeStrategy?: 'squash' | 'merge';
  /** Push to remote after merge (default: true) */
  autoPush?: boolean;
  /** Commit message (required for squash, auto-generated for merge) */
  commitMessage?: string;
  /** Run pre-flight conflict detection via merge-tree (default: true) */
  preflight?: boolean;
  /** Fast-forward local target branch after push (default: true) */
  syncLocal?: boolean;
  /**
   * When true, skip all remote operations (fetch, push).
   * Auto-detected when no remote named 'origin' is configured.
   */
  localOnly?: boolean;
}

export interface MergeBranchResult {
  /** Whether the merge succeeded */
  success: boolean;
  /** Merge/squash commit hash if successful */
  commitHash?: string;
  /** Whether a conflict was detected */
  hasConflict: boolean;
  /** Error message if merge failed */
  error?: string;
  /** Files with conflicts, if any */
  conflictFiles?: string[];
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Run a git command in a worktree directory.
 * Refuses to run in the workspace root to prevent corrupting the main repo HEAD.
 */
export async function execGitSafe(
  command: string,
  worktreePath: string,
  workspaceRoot: string
): Promise<{ stdout: string; stderr: string }> {
  if (path.resolve(worktreePath) === path.resolve(workspaceRoot)) {
    throw new Error(
      `SAFETY: Refusing to run "git ${command}" in main repo. Use a worktree.`
    );
  }
  return execAsync(`git ${command}`, { cwd: worktreePath, encoding: 'utf8' });
}

/**
 * Check whether a named remote exists in the repo.
 *
 * Runs `git remote get-url <remoteName>` which exits 0 when the remote
 * exists and non-zero otherwise.
 */
export async function hasRemote(
  workspaceRoot: string,
  remoteName = 'origin'
): Promise<boolean> {
  try {
    await execAsync(`git remote get-url ${remoteName}`, {
      cwd: workspaceRoot,
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the default target branch for the repo by checking origin/HEAD,
 * then falling back to origin/main, then origin/master, then 'main'.
 * When no remote exists, falls back to local branch detection.
 */
export async function detectTargetBranch(workspaceRoot: string): Promise<string> {
  const remoteExists = await hasRemote(workspaceRoot);

  if (remoteExists) {
    // Try origin/HEAD symref
    try {
      const { stdout } = await execAsync('git symbolic-ref refs/remotes/origin/HEAD', {
        cwd: workspaceRoot,
        encoding: 'utf8',
      });
      const match = stdout.trim().match(/refs\/remotes\/origin\/(.+)/);
      if (match) return match[1];
    } catch {
      // Fall through
    }

    // Try origin/main
    try {
      await execAsync('git rev-parse --verify origin/main', {
        cwd: workspaceRoot,
        encoding: 'utf8',
      });
      return 'main';
    } catch {
      // Fall through
    }

    // Try origin/master
    try {
      await execAsync('git rev-parse --verify origin/master', {
        cwd: workspaceRoot,
        encoding: 'utf8',
      });
      return 'master';
    } catch {
      // Fall through
    }
  }

  // No remote or remote detection failed — try local branches
  for (const name of ['main', 'master']) {
    try {
      await execAsync(`git rev-parse --verify refs/heads/${name}`, {
        cwd: workspaceRoot,
        encoding: 'utf8',
      });
      return name;
    } catch {
      // Fall through
    }
  }

  return 'main';
}

// ============================================================================
// Main
// ============================================================================

/**
 * Perform a merge of `sourceBranch` into `targetBranch` using a temporary
 * worktree. This never touches the main repo's HEAD or index.
 */
export async function mergeBranch(options: MergeBranchOptions): Promise<MergeBranchResult> {
  const {
    workspaceRoot,
    sourceBranch,
    mergeStrategy = 'squash',
    autoPush = true,
    commitMessage,
    preflight = true,
    syncLocal = true,
  } = options;

  // Auto-detect local-only mode when no remote is configured
  const localOnly = options.localOnly ?? !(await hasRemote(workspaceRoot));

  const targetBranch = options.targetBranch ?? await detectTargetBranch(workspaceRoot);

  // Build commit message
  const message = commitMessage
    ?? (mergeStrategy === 'squash'
      ? `Squash merge ${sourceBranch} into ${targetBranch}`
      : `Merge branch '${sourceBranch}'`);

  // 1. Fetch latest remote state (skip when local-only)
  if (!localOnly) {
    await execAsync('git fetch origin', { cwd: workspaceRoot, encoding: 'utf8' });
  }

  // 2. Pre-flight conflict detection via merge-tree
  // When local-only, use the local targetBranch ref instead of origin/<targetBranch>
  if (preflight) {
    const preflightRef = localOnly ? targetBranch : `origin/${targetBranch}`;
    try {
      const { stdout: mergeBase } = await execAsync(
        `git merge-base ${preflightRef} ${sourceBranch}`,
        { cwd: workspaceRoot, encoding: 'utf8' }
      );
      const dryRun = await execAsync(
        `git merge-tree ${mergeBase.trim()} ${preflightRef} ${sourceBranch}`,
        { cwd: workspaceRoot, encoding: 'utf8' }
      ).catch((e: { stdout?: string }) => e);
      if ((dryRun as { stdout?: string }).stdout?.includes('<<<<<<<')) {
        const dryRunOutput = (dryRun as { stdout: string }).stdout;
        const conflictFiles = [...dryRunOutput.matchAll(/\+\+\+ b\/(.+)/g)].map(m => m[1]);
        return {
          success: false,
          hasConflict: true,
          error: 'Pre-flight: merge conflicts detected',
          conflictFiles: conflictFiles.length > 0 ? conflictFiles : undefined,
        };
      }
    } catch {
      // merge-base can fail if branches have no common ancestor; continue to worktree merge
    }
  }

  // 3. Create temp worktree
  const safeName = sourceBranch.replace(/[^a-zA-Z0-9-]/g, '-');
  const mergeDirName = `_merge-${safeName}-${Date.now()}`;
  const mergeDir = path.join(workspaceRoot, '.stoneforge/.worktrees', mergeDirName);

  // Clean up leftover worktree from a previously crashed run
  if (fs.existsSync(mergeDir)) {
    await execAsync(`git worktree remove --force "${mergeDir}"`, {
      cwd: workspaceRoot, encoding: 'utf8',
    });
  }

  // Create with detached HEAD at the target ref.
  // When remote exists, use origin/<target> for the latest remote state;
  // when local-only, use the local <target> branch directly.
  const worktreeStartRef = localOnly ? targetBranch : `origin/${targetBranch}`;
  await execAsync(`git worktree add --detach "${mergeDir}" ${worktreeStartRef}`, {
    cwd: workspaceRoot, encoding: 'utf8',
  });

  let mergeResult: MergeBranchResult;

  try {
    let commitHash: string;

    if (mergeStrategy === 'squash') {
      await execGitSafe(`merge --squash ${sourceBranch}`, mergeDir, workspaceRoot);
      await execGitSafe(`commit -m "${message.replace(/"/g, '\\"')}"`, mergeDir, workspaceRoot);
      const { stdout: hash } = await execGitSafe('rev-parse HEAD', mergeDir, workspaceRoot);
      commitHash = hash.trim();
    } else {
      await execGitSafe(
        `merge --no-ff -m "${message.replace(/"/g, '\\"')}" ${sourceBranch}`,
        mergeDir, workspaceRoot
      );
      const { stdout: hash } = await execGitSafe('rev-parse HEAD', mergeDir, workspaceRoot);
      commitHash = hash.trim();
    }

    // 6. Push to remote (skip when local-only or push disabled)
    if (autoPush && !localOnly) {
      try {
        await execGitSafe(`push origin HEAD:${targetBranch}`, mergeDir, workspaceRoot);
      } catch (pushError) {
        const pushErrorMsg = pushError instanceof Error ? pushError.message : String(pushError);
        console.warn(`[git/merge] Failed to push to remote: ${pushErrorMsg}`);
      }
    }

    mergeResult = { success: true, commitHash, hasConflict: false };
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; message?: string };
    const output = (execError.stdout ?? '') + (execError.stderr ?? '') + (execError.message ?? '');

    if (output.includes('CONFLICT') || output.includes('Automatic merge failed')) {
      // Abort the merge to clean up
      try {
        if (mergeStrategy === 'squash') {
          await execGitSafe('reset --hard HEAD', mergeDir, workspaceRoot);
        } else {
          await execGitSafe('merge --abort', mergeDir, workspaceRoot);
        }
      } catch {
        // Ignore abort errors
      }

      const conflictMatch = output.match(/CONFLICT \([^)]+\): Merge conflict in (.+)/g);
      const conflictFiles = conflictMatch?.map((m) => {
        const match = m.match(/in (.+)$/);
        return match ? match[1] : '';
      }).filter(Boolean);

      mergeResult = {
        success: false,
        hasConflict: true,
        error: 'Merge conflict detected',
        conflictFiles,
      };
    } else {
      mergeResult = {
        success: false,
        hasConflict: false,
        error: output || 'Merge failed',
      };
    }
  } finally {
    // 7. Always remove temp worktree
    try {
      await execAsync(`git worktree remove --force "${mergeDir}"`, {
        cwd: workspaceRoot, encoding: 'utf8',
      });
    } catch {
      // Ignore cleanup errors
    }
  }

  // 8. Sync local target branch
  // In local-only mode, fast-forward the local target branch to the merge commit.
  // With a remote, sync local branch after push (best-effort).
  if (mergeResult.success && syncLocal) {
    if (localOnly) {
      await syncLocalBranchFromCommit(workspaceRoot, targetBranch, mergeResult.commitHash!);
    } else if (autoPush) {
      await syncLocalBranch(workspaceRoot, targetBranch);
    }
  }

  return mergeResult;
}

/**
 * Fast-forward the local target branch ref to match origin, without
 * the dangerous checkout dance.
 *
 * - When NOT on the target branch: `git fetch origin target:target`
 *   updates the local ref without touching the working tree at all.
 * - When ON the target branch: `git merge --ff-only origin/target`
 *   fast-forwards in place (unavoidably touches working tree files).
 * - If either fails (e.g. non-ff divergence): logs a warning and
 *   returns silently. The merge is already pushed to remote.
 */
export async function syncLocalBranch(
  workspaceRoot: string,
  targetBranch: string
): Promise<void> {
  try {
    // Determine current branch (may be detached HEAD in worktrees)
    let currentBranch: string | undefined;
    try {
      const { stdout } = await execAsync(
        'git symbolic-ref --short HEAD',
        { cwd: workspaceRoot, encoding: 'utf8' }
      );
      currentBranch = stdout.trim();
    } catch {
      // Detached HEAD — not on any branch
    }

    if (!currentBranch) {
      console.warn('[git/merge] WARNING: workspace is in detached HEAD state during syncLocalBranch. Skipping sync. Run `git checkout master` to fix.');
      return;
    }

    if (currentBranch === targetBranch) {
      // We're on the target branch — fast-forward in place
      await execAsync(`git merge --ff-only origin/${targetBranch}`, {
        cwd: workspaceRoot, encoding: 'utf8',
      });
    } else {
      // Not on target branch — update the ref without touching the worktree
      await execAsync(`git fetch origin ${targetBranch}:${targetBranch}`, {
        cwd: workspaceRoot, encoding: 'utf8',
      });
    }
  } catch {
    // Non-fatal: local branch sync is best-effort.
    // The merge is already pushed to remote — user can `git pull` manually.
    console.warn('[git/merge] Failed to fast-forward local target branch (non-ff divergence or missing ref). Run `git pull` to sync manually.');
  }
}

/**
 * Fast-forward the local target branch to a specific commit hash.
 *
 * Used in local-only mode where there is no remote to sync from.
 * Updates the branch ref directly using `git branch -f` when not on
 * the target branch, or `git merge --ff-only <hash>` when on it.
 */
export async function syncLocalBranchFromCommit(
  workspaceRoot: string,
  targetBranch: string,
  commitHash: string
): Promise<void> {
  try {
    // Determine current branch
    let currentBranch: string | undefined;
    try {
      const { stdout } = await execAsync(
        'git symbolic-ref --short HEAD',
        { cwd: workspaceRoot, encoding: 'utf8' }
      );
      currentBranch = stdout.trim();
    } catch {
      // Detached HEAD
    }

    if (currentBranch === targetBranch) {
      // On the target branch — fast-forward in place
      await execAsync(`git merge --ff-only ${commitHash}`, {
        cwd: workspaceRoot, encoding: 'utf8',
      });
    } else {
      // Not on target branch — force-update the ref to point at the merge commit
      await execAsync(`git branch -f ${targetBranch} ${commitHash}`, {
        cwd: workspaceRoot, encoding: 'utf8',
      });
    }
  } catch {
    console.warn('[git/merge] Failed to update local target branch after local-only merge.');
  }
}
