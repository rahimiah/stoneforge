---
"@stoneforge/smithy": minor
---

Add rate limit detection to headless session spawner. The spawner now detects rate limit messages in the headless session message stream using the rate-limit-parser utility and emits `rate_limited` events with the message content, parsed reset time, and executable path. Events are forwarded through the session manager's event pipeline.
