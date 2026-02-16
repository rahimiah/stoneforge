---
"@stoneforge/core": minor
"@stoneforge/storage": minor
"@stoneforge/quarry": minor
"@stoneforge/smithy": minor
"@stoneforge/ui": minor
"@stoneforge/shared-routes": minor
---

quarry: Add dispatch-ready task listing CLI command, fix blocked cache cascade for plan-level dependencies, add blocked-plan filter to ready(), update sf init gitignore template and handle cloned repos

smithy: Fix plugin executor timeout by using process group kill to ensure child processes are terminated on CI
