---
"@stoneforge/smithy": patch
---

Fix agent pool slots leaking permanently and wedging dispatch

`activeCount` was tracked independently of `activeAgentIds`, so the two drifted.
A duplicate spawn appended the id twice and incremented the count twice, while
the release path filtered every occurrence but decremented only once — leaving
the counter permanently above the real list length. Once a role reached its
`maxSlots` the pool reported zero available slots with no live sessions and no
agent of that role could ever spawn again, which presents as a broken daemon.
Both counters are now derived from `activeAgentIds`, and spawn is idempotent.
