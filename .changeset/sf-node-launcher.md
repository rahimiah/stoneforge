---
"@stoneforge/smithy": patch
---

Run `sf` under the server's Node interpreter instead of the agent shell's

`dist/bin/sf` was a symlink to a `#!/usr/bin/env node` script, so `sf task
complete` ran under whatever Node the agent's login shell resolved. Stoneforge
requires node >=18 <25; when the shell's default falls outside that range, sf
cannot load its native sqlite binding and every completion and handoff fails,
leaving tasks stuck and sessions resumed indefinitely. `sf` is now a small
launcher that execs `$STONEFORGE_NODE` (exported by every provider adapter as the
interpreter running the server), falling back to `node` for interactive use.
