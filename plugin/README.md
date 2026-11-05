# Cairn plugin for Claude Code

Connects Claude Code to a Cairn server and adds five skills:

- `cairn-notes`: how to write notes that stay findable and true.
- `cairn-continue`: resume work (core memory, then the relevant notes).
- `cairn-capture`: save decisions and outcomes unprompted, in interactive sessions only.
- `cairn-gardening`: act on the nightly gardening report.
- `cairn-tasks`: track multi-session work as task notes.

A SessionStart hook prints one line reminding the assistant to call `core_memory`.

The MCP server URL is `${CAIRN_URL}/mcp`, defaulting to `https://cairn.onewheelgeek.net`. For a
self-hosted Cairn, set `CAIRN_URL` (e.g. `export CAIRN_URL=https://cairn.example.com`) before
starting Claude Code. The first tool call opens a browser to sign in with your passkey.

The skills here are copies of `../skills/` (synced by `mise run plugin:sync`; `mise run lint`
fails if they drift).
