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
    tool.ts           # partial_compact tool definition
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
  dist/               # bun build output
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
  tool: { partial_compact: ... },
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

Native Opencode compaction path:

```text
Opencode native compaction starts
  experimental.chat.messages.transform        (us — collapse selected head)
  native compaction model call
  later messages.transform sees native compaction parts
    [opencode-partial-compact]               (safely prune stale sidecar records)
```

We **MUST** run before oh-my-openagent. The check is deferred to first hook use
because `server()` must not call the Opencode HTTP client during bootstrap;
we error out if the plugin order is wrong.

## Hooks we consume

- `Hooks.tool` — register `partial_compact`.
- `experimental.chat.messages.transform` — rewrite the view.
- `experimental.chat.system.transform` — occasionally remind the agent
  to consider partial compaction after visible context grows.

We do NOT consume `experimental.session.compacting`,
`experimental.compaction.autocontinue`, or `chat.params`.

## Tool execute path

```ts
async execute(args, ctx) {
  validateRange(args, ctx.sessionID)         // pure
  const record = { from, to, summary, ... }
  await state.add(ctx.sessionID, record)     // persistence
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
  "reminder_context_fraction": 0.1,
  "reminder_min_tokens": 4000,
  "debug_log_path": null
}
```

No `inject_id_tags`, no `min_age_parts`, no `warn_on_plugin_order` —
all dropped per v0 scope or hardened to errors.

## Boundaries

- Opencode's current auto-compaction trigger can still be based on the previous
  assistant message's recorded token usage. The plugin cannot rewrite that
  already-recorded number, but both normal prompting and native compaction pass
  through `experimental.chat.messages.transform`, so subsequent model-visible
  context and native compaction inputs use the partial-compacted view.
- `/compact` and automatic native compaction remain Opencode-owned. We do not
  inject partial summaries into their prompts.
