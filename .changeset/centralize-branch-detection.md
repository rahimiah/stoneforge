---
"@stoneforge/smithy": minor
---

Centralize branch detection into a single canonical `detectTargetBranch()` function in `git/merge.ts`. All 5 consumers (worktree-manager, merge-steward-service, docs-steward-service, CLI merge command) now delegate to the canonical function with a unified fallback order: config baseBranch → symref → remote show → origin/main → origin/master → local main → local master → "main". Fixes inverted master/main fallback in the CLI merge command.
