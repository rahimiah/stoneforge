---
"@stoneforge/quarry": patch
---

Fix `sf install skills` failing to find skills in NPM installs by correcting package resolution from `@stoneforge/orchestrator-sdk` to `@stoneforge/smithy` in all four discovery paths.
