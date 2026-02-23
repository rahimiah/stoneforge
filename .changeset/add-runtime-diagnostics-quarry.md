---
"@stoneforge/quarry": minor
---

Extend sf doctor to query smithy-server runtime diagnostics after existing DB health checks. Displays rate limits, stuck tasks, merge queue health, error rates, and agent pool utilization with pass/warn/fail status. Gracefully skips if smithy-server is unavailable.
