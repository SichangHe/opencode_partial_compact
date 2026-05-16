# opencode-partial-compact

Agent-driven partial context compaction for [Opencode](https://opencode.ai).
Empirically validated against Opencode 1.14.46.

## What it does

Exposes one tool — `pc_compact(from_message_id, to_message_id, summary)` — that lets the
agent replace a contiguous range of past messages with a short summary it writes.
The originals remain in Opencode's session log; only the in-memory view sent to
the LLM is modified. This shrinks token usage without destroying history.

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-partial-compact"]
}
```

Or for a local checkout:

```json
{
  "plugin": ["file:///absolute/path/to/dist/index.js"]
}
```

## Configuration

Create `.opencode/opencode-partial-compact.jsonc` in your project root, or
`~/.config/opencode/opencode-partial-compact.jsonc` for user-global config:

```jsonc
{
  "enabled": true,
  "max_summary_chars": 2000,
  "debug_log_path": null  // set to a file path to enable debug logging
}
```

## Coexistence

- **Incompatible** with `@tarquinen/opencode-dcp` — plugin will refuse to load
  if both are configured.
- **Order-sensitive** with `oh-my-openagent` — `opencode-partial-compact` must
  appear **before** `oh-my-openagent` in the plugin list.

## Dev workflow

```sh
bun install
bun run build   # tsc → dist/
bun test        # snapshot + validate + state tests
bun x tsc --noEmit  # type-check only
```

## Persistence

Compaction records are stored as JSON sidecars at:

```
~/.local/share/opencode/storage/plugin/opencode-partial-compact/{sessionId}.json
```

Writes are atomic (write-to-tmp, fsync, rename).
