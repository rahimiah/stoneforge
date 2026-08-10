#!/bin/sh
# Launcher for the `sf` CLI.
#
# sf.js carries a `#!/usr/bin/env node` shebang, so invoking it directly runs it
# under whatever Node the caller's shell happens to resolve. Agents run `sf task
# complete` from a login shell, whose Node is chosen by the user's profile and is
# frequently NOT the one the Stoneforge server runs under. Stoneforge requires
# node >=18 <25; when the shell resolves something outside that range, sf fails to
# load its native sqlite binding and every completion and handoff breaks. The task
# then never transitions and the session is resumed indefinitely.
#
# The provider adapters export STONEFORGE_NODE with the interpreter running the
# server (process.execPath), which is compatible by construction. Fall back to a
# bare `node` so humans running sf by hand keep the previous behaviour.
exec "${STONEFORGE_NODE:-node}" "$(dirname "$0")/sf.js" "$@"
