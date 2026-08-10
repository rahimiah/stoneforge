---
"@stoneforge/smithy": patch
---

Fix OpenCode workers being unable to run `sf`, by setting environment on `process.env`

The OpenCode SDK's `ServerOptions` has no `env` field and spawns its server with
`{ ...process.env }`, so everything the adapter passed as `env` was silently
discarded: `OPENCODE_PERMISSION`, `OPENCODE_CLIENT`, `STONEFORGE_ROOT`, and the sf
CLI PATH entry. Without `sf` on PATH an OpenCode-hosted worker cannot run
`sf task complete` or `sf task handoff`, so its task never transitions and the
session is resumed indefinitely.
