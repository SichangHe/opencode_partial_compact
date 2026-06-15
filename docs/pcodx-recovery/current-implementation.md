# current implementation

repo layers

- OpenCode plugin
  - package root
  - shipped behavior
    - `partial_compact`
    - `partial_compact_instructions`
    - `partial_compact_current_session_message_ids`
    - `/partial_compact` TUI command
  - real compaction point
    - OpenCode `experimental.chat.messages.transform`
  - storage
    - JSON sidecars under OpenCode plugin storage
  - status
    - internally coherent for OpenCode
- Codex wrapper experiment
  - path
    - `experiments/codex-wrapper`
  - contains two different PCODX paths
    - MCP sidecar worker path
    - app-server controller path

OpenCode plugin control flow

- config load
  - `src/plugin.ts`
  - reads project or user `opencode-partial-compact.jsonc`
  - forces OpenCode native `compaction.auto=false` while enabled
- agent tool call
  - `src/tool.ts`
  - validates current-session message-id ranges
  - writes compaction records through `src/state.ts`
  - does not mutate OpenCode's SQLite log
- view rewrite
  - `src/hook.ts`
  - loads sidecar records
  - replaces a selected message range in the in-memory message array
  - leaves the first message with one synthetic compacted text part
  - removes interior messages from the array sent to the model
- reminder
  - `src/reminder.ts`
  - estimates visible tokens after applying sidecar compactions
  - injects terse system reminders through OpenCode system transform
- TUI route
  - `src/tui.ts`
  - asks the agent to call the tool for a selected checkpoint

OpenCode tricky boundaries

- the sidecar is not the compaction itself
  - it is durable instruction for the next message-transform hook
- OpenCode shrink works because the hook is inside OpenCode's prompt assembly
  - sidecar records are applied before the model-visible request is built
- native OpenCode compaction is still a fallback
  - partial records are reconciled when native compaction removes endpoints
- cache economics are not automatic wins
  - tail compaction is cheap
  - middle-history compaction can invalidate cached prefix

Codex MCP sidecar path

- entrypoint
  - `experiments/codex-wrapper/src/mcp-server.ts`
- startup text
  - `experiments/codex-wrapper/src/pcodx-instructions.ts`
- durable state
  - `PCODX_LEDGER_PATH`
  - rendered artifact beside the ledger
- tools
  - `partial_compact_record_message`
  - `partial_compact_current_ids`
  - `partial_compact_current_session_message_ids`
  - `partial_compact`
- actual effect
  - appends and compacts `WrapperLedger`
  - writes rendered visible context artifact
  - returns receipts with `native_context_rewritten: false`

Codex app-server controller path

- main owner
  - `experiments/codex-wrapper/src/self-compacting-controller.ts`
- CLI wrapper
  - `experiments/codex-wrapper/src/controller-cli.ts`
- manager launcher
  - `experiments/codex-wrapper/src/manager-agent-launch.ts`
- core mechanism
  - controller owns a `WrapperLedger`
  - controller renders compacted visible context
  - controller starts a fresh app-server thread
  - controller injects the render as prior context
  - dynamic tools mutate the controller ledger during a turn
  - the next controller-started turn uses the compacted render
- observable metric
  - `thread/tokenUsage/updated`
  - `token_usage.last.inputTokens`
  - `modelContextWindow`

reusable virtual context concepts

- stable visible ids
  - `msg...` for raw messages
  - `cmp...` for compaction records in rendered views
- ledger render
  - explicit XML-like blocks for messages and compacted summaries
- range validation
  - endpoints must exist
  - ranges must be ordered
  - ranges must not overlap prior or pending compactions
- receipts
  - must state whether native context was rewritten
  - must expose visible ids and artifact paths

