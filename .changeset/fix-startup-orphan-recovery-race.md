---
"@stoneforge/smithy": patch
---

Fix TOCTOU race condition in startup orphan recovery. Replace boolean `startupRecoveryInFlight` flag with a promise-based latch (`startupRecoveryDone`) that `runPollCycle()` awaits before running its own orphan recovery, preventing concurrent recovery on the same tasks.
