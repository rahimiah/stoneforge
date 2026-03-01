---
"@stoneforge/smithy": minor
---

Add multiple directors support to backend services

- Add `getDirectors()` method to AgentRegistry returning all director-role agents
- Add `getTaskDirector()` and `getAgentDirector()` helpers for multi-director message routing
