---
"@stoneforge/smithy": patch
---

Capture token usage from OpenCode sessions

OpenCode reports usage as `properties.info.tokens = { input, output, ... }` on
assistant messages, a shape `extractTokenUsage` did not recognise — so OpenCode
sessions recorded the correct provider and model but always zero tokens, leaving
cost-per-task unavailable for non-Claude workers. These events are cumulative per
message, so usage is now tracked per message id (last write wins) and summed
across distinct messages; summing every event would have multiplied real usage
several times over.
