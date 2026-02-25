# KYZN Codebase Security Review (2026-02-25)

## Scope
- Reviewed server-side attack surface in `@stoneforge/smithy` and `@stoneforge/quarry`.
- Focused on file system operations, process spawning, external fetch/proxy behavior, and control-plane endpoints.

## Findings (Highest to Lowest Severity)

### 1) Unauthenticated control-plane endpoints (Critical)
- Status: Open
- Impact: Any client with network access to the orchestrator server can start/stop/resume agent sessions, send session input, manipulate worktrees, and read/write workspace files.
- Evidence:
  - `packages/smithy/src/server/index.ts`
  - `packages/smithy/src/server/routes/sessions.ts`
  - `packages/smithy/src/server/routes/worktrees.ts`
  - `packages/smithy/src/server/routes/workspace-files.ts`
- Recommendation:
  - Add authentication middleware for all `/api/*` routes.
  - Add authorization policy by role (`director`, `worker`, `steward`, human operator).
  - Restrict server binding to loopback by default and warn/fail when bound externally without auth.

### 2) Symlink escape in workspace file APIs (High)
- Status: Fixed in this branch
- Impact: Without realpath-based checks, a symlink inside the workspace could point outside the workspace and allow unintended read/write access.
- Fix:
  - Added realpath + ancestor validation for existing and write-target paths.
  - Ensures resolved paths remain within workspace root even through symlinks.
- Files changed:
  - `packages/smithy/src/server/routes/workspace-files.ts`

### 3) Shell invocation risk in LSP command availability checks (Medium)
- Status: Fixed in this branch
- Impact: Shell-based `execSync("which ${cmd}")` is an unsafe pattern and can become injectable if command sources change.
- Fix:
  - Replaced shell execution with argument-safe `execFileSync('which', [cmd])`.
- Files changed:
  - `packages/smithy/src/server/services/lsp-manager.ts`

### 4) Extension download trust boundary (Medium)
- Status: Fixed in this branch
- Impact: Metadata-provided VSIX download URLs were used directly; a compromised upstream response could trigger server-side fetches to untrusted hosts.
- Fix:
  - Enforced HTTPS + trusted-host allowlist for VSIX download URLs.
- Files changed:
  - `packages/smithy/src/server/routes/extensions.ts`

### 5) Terminal upload endpoint lacked explicit size limit (Medium)
- Status: Fixed in this branch
- Impact: Unbounded upload payload could cause memory/disk pressure (DoS).
- Fix:
  - Added 10MB max upload size enforcement with `413` response.
- Files changed:
  - `packages/smithy/src/server/routes/upload.ts`

## Verification
- `pnpm --filter @stoneforge/smithy build` passed.

## Next Actions
1. Implement authn/authz middleware and apply to all control/file-system routes.
2. Add integration tests for auth enforcement and symlink traversal denial.
3. Add security regression tests for extension download host validation.
