---
"@stoneforge/smithy": patch
---

Send the worker's working directory on every OpenCode session request

The adapter passed `cwd` to `createOpencode`, which the SDK discards — and since
one shared OpenCode server serves every session, a single startup directory could
never be correct anyway. Sessions were created with no directory at all, so
OpenCode rooted its project context at the Stoneforge server's own cwd rather than
the agent's worktree. The session endpoints accept a `?directory=` query
parameter, which is now sent on create, get, prompt, and abort.
