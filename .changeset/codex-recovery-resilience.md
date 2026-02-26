---
"@stoneforge/smithy": patch
---

Fix Codex worker recovery crash loops with three targeted fixes:

1. **resumeCount race condition**: Moved resumeCount increment from pre-recovery to post-recovery (in the rapid-exit detector's onExit callback). Only successful sessions now burn the resume budget; rapid exits from rate limits or thread failures no longer prematurely trigger recovery stewards.

2. **sessionProvider tracking**: Store the provider that created each session alongside the sessionId. Before resume, verify the current worker's provider matches the stored sessionProvider. Provider mismatches (e.g., Codex worker trying to resume a Claude session) now skip resume and start fresh instead of crashing.

3. **Codex thread.resume fallback**: When thread.resume fails (thread not found, expired, corrupted), gracefully fall back to thread.start instead of propagating the error and triggering crash loops.
