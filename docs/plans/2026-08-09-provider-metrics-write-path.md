# Provider Metrics Write-Path Correction Plan

## Scope

Correct the existing provider metrics implementation in `packages/smithy/src/server/services.ts` and its colocated server test without changing the schema or read path.

## Steps

1. Inspect provider event adapters and real session JSONL payloads for Claude, Codex, and OpenCode model/usage fields.
2. Update `packages/smithy/src/server/services.bun.test.ts` with regression cases for cumulative Codex totals, provider fallback, model extraction, token accumulation, rate limits, and handoffs.
3. Make the minimal corresponding changes in `packages/smithy/src/server/services.ts`.
4. Run the focused server test, then Smithy typecheck, lint, and full test suite.
5. Produce a real worker session and query its persisted `provider_metrics` row for model, provider, and nonzero input/output tokens.
6. Commit, push, and complete task `el-3jzs` only after all acceptance criteria are evidenced.

## Expected Results

- Real provider and non-empty model are written.
- Session-total input and output tokens are written.
- `failed` and `rate_limited` take precedence over task-status-derived `handoff`.
- Full suite retains exactly the documented ten pre-existing failures.
