# opencode-partial-compact

Agent-driven partial context compaction for [Opencode](https://opencode.ai).
Originally validated against Opencode 1.14.46; current local compatibility is
checked against Opencode CLI 1.15.10 with `@opencode-ai/plugin`/
`@opencode-ai/sdk` 1.15.10.

## What it does

Exposes two tools:

- `partial_compact_instructions()` returns the named instruction block
  `opencode-partial-compact`. Agents should read it before calling
  `partial_compact` if it is not already in their context window.
- `partial_compact(...)` lets the agent replace one contiguous current-session
  message range, or multiple disjoint current-session ranges, with short
  summaries it writes: `ranges: [{ from_message_id, to_message_id, summary }]`.
  Agents do not choose a session; the tool compacts only the current session.

Periodic reminders tell the agent when the model-visible context has grown
enough to warrant cleanup, using the conservative smaller of `limit.input` and `limit.context` when available and escalating wording at 50%, 80%, and 90% of that effective budget. The full tool and reminder contract lives in
[`docs/20-agent-tools.md`](docs/20-agent-tools.md). Reminders are mandatory
checkpoints that point to `partial_compact_instructions`; read that guide
before compacting unless the named instruction is already in context. Reminders
and `partial_compact_instructions` include the current session's ordered `msg...`
IDs so agents can choose stable current-session range endpoints without guessing.

It also exposes a TUI slash command, `/partial_compact`, that lets the user pick
the checkpoint to compact through. The command asks the agent to summarize that
range with `partial_compact` and includes the full instruction block.
Older local checkouts exposed this agent tool as `pc_compact`; update any saved
prompts or automation to call `partial_compact` instead.
The originals remain in Opencode's session log; only the in-memory view sent to
the LLM is modified. This shrinks token usage without destroying history.

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-partial-compact"],
  "compaction": { "auto": false }
}
```

Or for a local checkout:

```json
{
  "plugin": ["file:///absolute/path/to/dist/index.js"],
  "compaction": { "auto": false }
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
  "reminder_interval_tokens": 16000,
  "debug_log_path": null  // set to a file path to enable debug logging
}
```

Native auto-compaction must stay disabled while this plugin is enabled. The plugin enforces this in Opencode's merged runtime config and the explicit setting below documents the intended boundary:

```jsonc
{
  "compaction": { "auto": false }
}
```

Opencode schedules automatic compaction from the previous assistant message's
recorded token usage before plugins can recompute the partial-compacted
effective context. This plugin sets `compaction.auto=false` through Opencode's config hook and keeps a lazy fail-safe check, avoiding stale-trigger native compactions when the current visible context is already small. If Opencode still reaches the native compaction path near overflow, the plugin lets that native fallback run instead of throwing; partial compaction remains the preferred proactive path, but high-context sessions should recover rather than stop silently.

`reminder_interval_tokens` is the target reminder cadence. If the active model
reports an input budget or context window smaller than that target, the runtime
uses an internal safety interval of roughly 80% of that effective budget so
mandatory reminders still appear before the window is exhausted. Reminder text uses the conservative smaller of `limit.input` and `limit.context` when available; when both are unknown, the configured target is used unchanged.

## Coexistence

- **Incompatible** with `@tarquinen/opencode-dcp` — plugin will refuse to operate
  if both are configured.
- **Order-sensitive** with `oh-my-openagent` — `opencode-partial-compact` must
  appear **before** `oh-my-openagent` in the plugin list.

## Dev workflow

```sh
bun install
bun run build   # tsc → dist/ and copies src/prompts → dist/prompts
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
