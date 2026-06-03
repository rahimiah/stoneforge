# Stoneforge: Dependency Enforcement + Merge Verification Fix

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix two bugs — (1) the dispatch daemon ignores task dependencies, dispatching blocked tasks out of order, and (2) the merge steward marks tasks as "merged" without verifying that the target branch HEAD actually advanced.

**Architecture:** Minimal patches to two existing methods. No new tables, no new services, no new APIs. The dependency data already exists in the `dependencies` table — the daemon just doesn't read it. The merge commit hash already exists — the steward just doesn't verify it reached the target branch.

**Tech Stack:** TypeScript, SQLite (via Stoneforge's backend), git CLI.

---

### Task 1: Dependency enforcement in `ready()`

**Files:**
- Modify: `packages/quarry/src/api/quarry-api.ts:2444-2448`
- Test: `packages/quarry/src/api/quarry-api.test.ts` (or nearest test file)

**The bug:** Lines 2444-2448 only check `blocked_cache` for blocked tasks. The `blocked_cache` can be stale. The `dependencies` table has the authoritative blocking relationships but is never queried here.

**Step 1: Write the failing test**

```typescript
// Test that a task blocked by an open dependency is NOT returned by ready()
it('should not return tasks blocked by an incomplete dependency', async () => {
  // Create two tasks: blocker and blocked
  const blocker = await api.createTask({ title: 'Blocker', status: 'open', createdBy: 'test' });
  const blocked = await api.createTask({ title: 'Blocked', status: 'open', createdBy: 'test' });
  
  // Create a blocks dependency: blocker blocks blocked
  await api.addDependency({
    blockedId: blocked.id,
    blockerId: blocker.id,
    type: 'blocks',
  });
  
  // ready() should return blocker but NOT blocked
  const readyTasks = await api.ready();
  const readyIds = readyTasks.map(t => t.id);
  
  expect(readyIds).toContain(blocker.id);
  expect(readyIds).not.toContain(blocked.id);
});

it('should return previously-blocked task after blocker is closed', async () => {
  const blocker = await api.createTask({ title: 'Blocker', status: 'open', createdBy: 'test' });
  const blocked = await api.createTask({ title: 'Blocked', status: 'open', createdBy: 'test' });
  
  await api.addDependency({
    blockedId: blocked.id,
    blockerId: blocker.id,
    type: 'blocks',
  });
  
  // Close the blocker
  await api.updateTask(blocker.id, { status: 'closed' });
  
  // Now blocked should be ready
  const readyTasks = await api.ready();
  const readyIds = readyTasks.map(t => t.id);
  
  expect(readyIds).toContain(blocked.id);
});
```

**Step 2: Run test to verify it fails**

```bash
cd ~/stoneforge
pnpm run test --filter=@stoneforge/quarry -- --grep "blocked by an incomplete dependency"
```

Expected: FAIL — `blocked` task appears in `readyTasks` because dependencies aren't checked.

**Step 3: Implement the fix**

In `packages/quarry/src/api/quarry-api.ts`, after line 2448 (the existing `blocked_cache` query), add a direct query against the `dependencies` table:

```typescript
    // Filter out blocked tasks (from cache)
    const blockedIds = new Set(
      this.backend.query<{ element_id: string }>(
        'SELECT element_id FROM blocked_cache'
      ).map((r) => r.element_id)
    );

    // PATCH: Also check dependencies table directly.
    // A task is blocked if it has a 'blocks' or 'awaits' dependency
    // where the blocker is NOT closed. This is defense-in-depth
    // against stale blocked_cache entries.
    const depBlockedIds = this.backend.query<{ blocked_id: string }>(
      `SELECT DISTINCT d.blocked_id
       FROM dependencies d
       JOIN elements e ON d.blocker_id = e.id
       WHERE d.type IN ('blocks', 'awaits')
         AND e.deleted_at IS NULL
         AND e.status != 'closed'`
    ).map((r) => r.blocked_id);
    
    for (const id of depBlockedIds) {
      blockedIds.add(id);
    }
```

This adds the dependency-blocked task IDs to the same `blockedIds` set that the existing filter at line 2500 checks. No other changes needed — the existing `if (blockedIds.has(task.id)) return false;` handles the rest.

**Step 4: Run test to verify it passes**

```bash
cd ~/stoneforge
pnpm run test --filter=@stoneforge/quarry -- --grep "blocked by an incomplete dependency"
```

Expected: PASS

**Step 5: Run full test suite**

```bash
cd ~/stoneforge
pnpm run test --filter=@stoneforge/quarry
```

Expected: All existing tests pass + new tests pass.

**Step 6: Commit**

```bash
cd ~/stoneforge
git add packages/quarry/src/api/quarry-api.ts packages/quarry/src/api/quarry-api.test.ts
git commit -m "fix(quarry): enforce dependency blocking in ready() — query dependencies table directly

The dispatch daemon's ready() method only checked blocked_cache for
blocked tasks. If the cache was stale, tasks with unresolved 'blocks'
or 'awaits' dependencies were dispatched out of order.

Now ready() also queries the dependencies table directly as
defense-in-depth. A task is excluded if any blocker is non-closed.

Incident: AMI MCP sprint — 5 of 7 batches dispatched before their
prerequisite (Batch 1) completed, causing merge conflicts and rework."
```

---

### Task 2: Post-merge verification in merge steward

**Files:**
- Modify: `packages/smithy/src/services/merge-steward-service.ts:635-637`
- Modify: `packages/smithy/src/git/merge.ts:429-440`
- Test: `packages/smithy/src/services/merge-steward-service.test.ts` (or nearest)

**The bug:** After `mergeBranch()` returns `{ success: true }`, the steward calls `updateMergeStatus(taskId, 'merged')` without verifying that the target branch HEAD actually contains the merge commit. In local-only mode, `syncLocalBranchFromCommit()` can fail silently (caught at line 534), leaving the target branch unchanged while the steward claims success.

**Step 1: Write the failing test**

```typescript
it('should not claim merged if target branch HEAD did not advance', async () => {
  // This test would need to mock mergeBranch to return success: true
  // but have the local target branch not actually advance.
  // The simplest approach: verify that processTask checks target branch HEAD
  // after mergeBranch returns.
});
```

The exact test depends on the test infrastructure (mocks vs integration). The key assertion: if `git rev-parse main` is the same before and after `mergeBranch()`, the steward should NOT set `mergeStatus = 'merged'`.

**Step 2: Implement the fix**

In `packages/smithy/src/git/merge.ts`, modify the post-sync section (lines 429-440). After the sync attempt, verify the target branch actually points to the merge commit:

```typescript
  // 8. Sync local target branch
  if (mergeResult.success && syncLocal) {
    if (localOnly) {
      await syncLocalBranchFromCommit(workspaceRoot, targetBranch, mergeResult.commitHash!);
    } else if (autoPush) {
      await syncLocalBranch(workspaceRoot, targetBranch);
    }

    // PATCH: Verify the target branch actually advanced to the merge commit.
    // syncLocalBranchFromCommit can fail silently (catch at line 534).
    // If the target branch didn't advance, the merge didn't actually land.
    if (mergeResult.commitHash) {
      try {
        const { stdout: targetHead } = await execAsync(
          `git rev-parse ${targetBranch}`,
          { cwd: workspaceRoot, encoding: 'utf8' }
        );
        const targetHeadTrimmed = targetHead.trim();

        // Check if the merge commit is an ancestor of the target branch HEAD
        // (it should be exactly equal for fast-forward, or an ancestor for merge commits)
        try {
          await execAsync(
            `git merge-base --is-ancestor ${mergeResult.commitHash} ${targetHeadTrimmed}`,
            { cwd: workspaceRoot, encoding: 'utf8' }
          );
          // Exit code 0 means commitHash IS an ancestor — merge landed
        } catch {
          // Exit code 1 means commitHash is NOT an ancestor — merge didn't land
          mergeResult.success = false;
          mergeResult.error = `Merge commit ${mergeResult.commitHash.substring(0, 8)} did not reach target branch ${targetBranch} (HEAD: ${targetHeadTrimmed.substring(0, 8)})`;
        }
      } catch {
        // If we can't even read the target branch, something is very wrong
        mergeResult.success = false;
        mergeResult.error = `Failed to verify target branch ${targetBranch} after merge`;
      }
    }
  }

  return mergeResult;
```

This means `mergeBranch()` will return `{ success: false }` if the target branch didn't advance, and the merge steward's existing error handling at lines 656-670 will mark the task as `failed` instead of `merged`.

**Step 3: Run tests**

```bash
cd ~/stoneforge
pnpm run test --filter=@stoneforge/smithy
```

Expected: All existing tests pass. If any test relied on `mergeBranch` returning success without actually advancing the target branch, that test was testing the bug.

**Step 4: Commit**

```bash
cd ~/stoneforge
git add packages/smithy/src/git/merge.ts packages/smithy/src/services/merge-steward-service.test.ts
git commit -m "fix(smithy): verify target branch advanced after merge before claiming success

mergeBranch() returned success:true after syncLocalBranchFromCommit()
even when the sync failed silently. The merge steward then marked the
task as 'merged' without the target branch actually containing the
merge commit.

Now mergeBranch() verifies that the merge commit is an ancestor of
the target branch HEAD after sync. If not, returns success:false with
a descriptive error.

Incident: AMI MCP sprint — all 7 tasks marked 'merged' but zero
commits reached main. Manual merge was required for every batch."
```

---

## Post-fix verification

After both patches, test the full workflow:

```bash
cd ~/stoneforge && pnpm run test
```

Then test against the AMI project:

1. Start Stoneforge for AMI: `cd ~/ami && node ~/stoneforge/packages/smithy/dist/bin/sf.js serve --port 3460`
2. Create two tasks: A (open) and B (open)
3. Set dependency: B blocked by A
4. Start daemon
5. Verify: daemon dispatches A but NOT B
6. After A's worker completes and merges: verify B becomes dispatchable
7. After B's worker completes: verify `git log --oneline main` shows both commits

If both patches work, the AMI MCP sprint's failure mode is eliminated.
