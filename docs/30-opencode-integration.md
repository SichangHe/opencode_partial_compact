# Opencode Integration (v0)

## Package shape

```text
opencode-partial-compact/
  package.json
    name: "opencode-partial-compact"
    type: "module"
    main: "./dist/index.js"
    peerDependencies: { "@opencode-ai/plugin": ">=1.4.3" }
  tsconfig.json
  src/
    index.ts          # PluginModule default export
    plugin.ts         # server() body
    hook.ts           # messages.transform handler
    tool.ts           # pc_compact tool definition
    state.ts          # persistence (sidecar or piggyback per spike)
    validate.ts       # range validation
    log.ts            # optional debug log
  test/
    snapshot.test.ts  # F4 byte-stability test
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
  tool: { pc_compact: ... },
  "experimental.chat.messages.transform": handler,
}
```

## Install path

Empirically validated (POC):

1. User runs `bun publish` or installs from the repo. We support
   loading by `file://` URI in `opencode.json`'s `plugin` array — no
   npm publish required for local use.
2. User adds `"opencode-partial-compact"` (npm name) or
   `"file:///abs/path/to/dist/index.js"` to their `plugin` array.
3. Opencode's loader (`Bun.resolve(entry, configDir)` then dynamic
   import; binary string-line 215730 in v1.14.46) resolves either form.

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

We **MUST** run before oh-my-openagent. Enforced at `server()` init
(see `60-coexistence.md`); we error out if the plugin order is wrong.

## Hooks we consume

- `Hooks.tool` — register `pc_compact`.
- `experimental.chat.messages.transform` — rewrite the view.
- `event` — (optional, low priority) listen for `session.created` to
  pre-load state.

We do NOT consume `experimental.chat.system.transform`,
`experimental.session.compacting`, or `chat.params`.

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
  "debug_log_path": null
}
```

No `inject_id_tags`, no `min_age_parts`, no `warn_on_plugin_order` —
all dropped per v0 scope or hardened to errors.

## What we deliberately don't hook

- `experimental.chat.system.transform`
- `experimental.session.compacting`
- `experimental.compaction.autocontinue`
- `chat.params`, `chat.headers`, `tool.execute.*`

`/compact` (full compaction) remains entirely under user control.
