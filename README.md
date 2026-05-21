# opencode-partial-compact

Agent-driven partial context compaction for [Opencode](https://opencode.ai).
Empirically validated against Opencode 1.14.46.

## What it does

Exposes one tool — `partial_compact(from_message_id, to_message_id, summary)` — that lets the
agent replace a contiguous range of past messages with a short summary it writes.
The tool description and periodic system reminders nudge the agent to compact
bulky tool output, resolved detours, and obsolete investigation logs when those
details no longer need to stay verbatim in context.
It also exposes a TUI slash command, `/partial_compact`, that lets the user pick
the checkpoint to compact through. The command compacts from the first eligible
uncompacted message through that checkpoint, then asks the agent to summarize
that exact range with `partial_compact`.
Older local checkouts exposed this agent tool as `pc_compact`; update any saved
prompts or automation to call `partial_compact` instead.
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

For the slash command, add the TUI plugin target to `.opencode/tui.json` or your
user TUI config:

```json
{
  "plugin": ["opencode-partial-compact"]
}
```

Opencode's plugin installer detects both the server target and the `./tui`
target from this package. For a local checkout, keep the server path above and
add the TUI entrypoint separately:

```json
{
  "plugin": ["file:///absolute/path/to/dist/tui.js"]
}
```

## Configuration

Create `.opencode/opencode-partial-compact.jsonc` in your project root, or
`~/.config/opencode/opencode-partial-compact.jsonc` for user-global config:

```jsonc
{
  "enabled": true,
  "max_summary_chars": 2000,
  "reminder_enabled": true,
  "reminder_context_fraction": 0.1,
  "reminder_min_tokens": 4000,
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
On process restart, the first message transform reloads this sidecar and
reconstructs the same compacted model-visible view.
