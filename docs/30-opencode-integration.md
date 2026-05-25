# Opencode Integration (v0)

## Package shape

```text
opencode-partial-compact/
  package.json
    name: "opencode-partial-compact"
    type: "module"
    main: "./dist/index.js"
    exports: ".", "./server", "./tui"
    peerDependencies: { "@opencode-ai/plugin": ">=1.15.0", "@opencode-ai/sdk": ">=1.15.0" }
  tsconfig.json
  src/
    index.ts          # PluginModule default export
    plugin.ts         # server() body
    hook.ts           # messages.transform handler
    reminder.ts       # system reminder cadence + visible-token estimate
    tool.ts           # partial_compact + instruction tool definitions
    instructions.ts   # prompt accessors
    prompt-loader.ts  # Markdown prompt loader + renderer
    prompts/          # Markdown prompt source files copied to dist/prompts
    tui.ts            # /partial_compact TUI command
    tui-checkpoints.ts# checkpoint picker + one-shot agent prompt
    state.ts          # sidecar persistence
    validate.ts       # range validation
    log.ts            # optional debug log
  test/
    snapshot.test.ts  # F4 byte-stability test
    reminder.test.ts
    tui-checkpoints.test.ts
    validate.test.ts
    state.test.ts
  dist/               # tsc output plus copied prompt Markdown
```

## Plugin entry

```ts
import type { PluginModule } from "@opencode-ai/plugin"
import { server } from "./plugin"
const mod: PluginModule = { id: "opencode-partial-compact", server }
export default mod
```

`server` returns:

```ts
{
  tool: { partial_compact: ..., partial_compact_instructions: ... },
  "experimental.chat.messages.transform": handler,
  "experimental.chat.system.transform": reminderHandler,
}
```

## Install path

Empirically validated (POC):

1. User runs `bun publish` or installs from the repo. We support
   loading by `file://` URI in `opencode.json`'s `plugin` array — no
   npm publish required for local use.
2. User adds `"opencode-partial-compact"` (npm name) or
   `"file:///abs/path/to/dist/index.js"` to their `plugin` array.
3. For the slash command, user also adds `"opencode-partial-compact"`
   or `"file:///abs/path/to/dist/tui.js"` to TUI plugin config.

## Hook execution flow

```text
Opencode runLoop
  load messages from SQLite                  (Opencode core)
  filterCompactedEffect                      (Opencode /compact handling)
  experimental.chat.messages.transform
    [opencode-partial-compact]               (us — collapse per state)
    [oh-my-openagent]                        (after us — tool-pair repair etc.)
  toModelMessagesEffect                      (wire format)
  AI-SDK middleware → applyCaching → LLM
```

Native Opencode compaction guard:

```text
Opencode native compaction starts
  experimental.session.compacting             (us — allow fallback)
  experimental.compaction.autocontinue        (us — continue only after overflow fallback)
  later messages.transform sees native compaction parts only for older/escaped sessions
    [opencode-partial-compact]                (safely prune stale sidecar records)
```

We **MUST** run before oh-my-openagent. The check is deferred to first hook use
because `server()` must not call the Opencode HTTP client during bootstrap;
we error out if the plugin order is wrong.

## Hooks we consume

- `Hooks.tool` — register `partial_compact` and the read-only
  `partial_compact_instructions` guide tool.
- `experimental.chat.messages.transform` — rewrite the view.
- `experimental.chat.system.transform` — inject a mandatory partial-compaction
  reminder after visible context grows. The reminder reports the estimated
  visible context size, includes context-window percentage when available, targets staying below 50%, and
  points to the named instruction so agents can review the full compaction
  policy before choosing ranges. It also appends ordered current-session `msg...` IDs after existing
  partial compactions are applied. `reminder_interval_tokens` remains the
  configured target cadence; when a known model context window is smaller than
  that target, the runtime clamps the effective interval to an internal ~80%
  safety point.
- `partial_compact` records a fresh post-compaction visible-token estimate after
  each successful write. This makes the reminder cadence count from the compacted
  view immediately instead of waiting for the next system hook to notice the
  shrink.

We use `experimental.session.compacting` as a last-resort native overflow
fallback and `experimental.compaction.autocontinue` to keep synthetic
continuation enabled only after overflow fallback. We do NOT consume
`chat.params`.

## Tool execute path

```ts
async execute(args, ctx) {
  normalize ranges[] to ctx.sessionID
  validateRanges(ranges, messages, records)  // pure, all before writes
  const records = ranges.map(({ from, to, summary, ... }) => ...)
  await state.addCompactions(sessionID, records) // one current-session write
  return { n_messages_replaced, truncated }
}
```

The next LLM call's `messages.transform` will see the new record and
collapse the range. No reload step needed — state is in-process
between calls.

## Configuration

Project-local `.opencode/opencode-partial-compact.jsonc` or user-global
`~/.config/opencode/opencode-partial-compact.jsonc`. Initial schema:

```jsonc
{
  "$schema": "./schema.json",
  "enabled": true,
  "max_summary_chars": 2000,
  "reminder_enabled": true,
  "reminder_interval_tokens": 16000,
  "debug_log_path": null
}
```

No `inject_id_tags`, no `min_age_parts`, no `warn_on_plugin_order` —
all dropped per v0 scope or hardened to errors.

## Boundaries

- Opencode's current auto-compaction trigger can still be based on the previous
  assistant message's recorded token usage. The plugin cannot rewrite that
  already-recorded number, so it disables native auto-compaction before the
  scheduler runs. If a native compaction path still starts near overflow, the
  plugin allows it as a last-resort recovery fallback.
- Therefore this plugin enforces Opencode `compaction.auto=false` through the
  merged-config hook and keeps a lazy fail-safe check. Native triggers can fire
  before chat transforms recompute the partial-compacted effective context, so
  runtime config enforcement is the primary guard.
- Automatic native compaction is disabled with `compaction.auto=false` by the
  plugin config hook. `experimental.session.compacting` is allowed to proceed as
  an overflow fallback so high-context sessions compact instead of stopping. We
  do not inject partial summaries into native compaction prompts.
