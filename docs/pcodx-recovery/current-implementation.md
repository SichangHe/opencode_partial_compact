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
  - contains three different PCODX paths
    - MCP sidecar worker path
    - app-server controller path
    - Codex front-end proxy path

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
- actual effect
  - appends to `WrapperLedger`
  - writes rendered visible context artifact
  - returns receipts with `native_context_rewritten: false`

Codex app-server controller path

- main owner
  - `experiments/codex-wrapper/src/self-compacting-controller.ts`
- CLI wrapper
  - `experiments/codex-wrapper/src/agent-cli.ts`
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
- verification
  - `bun run agent -- verify`
  - `bun run verify:self-compaction`
  - runs typecheck, unit tests, front-end proxy smoke, context-shrink smoke, self-compacting controller smoke, and controller CLI smoke
  - writes `runs/verify-self-compaction/<run-id>/report.json`
  - records raw and compacted `last.inputTokens`, shrink fraction, context artifact paths, and context-file hashes
- wrapper UX
  - `bun run agent -- start` launches the manager/controller path
  - `bun run agent -- continue` resumes the same controller run dir and session id
  - `bun run agent -- evidence` reports latest controller run-dir shrink evidence
  - `bun run agent -- artifacts` lists controller ledger, context, last-turn, and per-turn files
  - wrapper receipts use `acceptance_scope=controller-owned app-server turns`
- observable metric
  - `thread/tokenUsage/updated`
  - `token_usage.last.inputTokens`
  - `modelContextWindow`

Codex front-end proxy path

- main owner
  - `experiments/codex-wrapper/src/frontend-proxy.ts`
- launcher
  - `experiments/codex-wrapper/src/frontend-cli.ts`
  - `bun run agent -- frontend -- --no-alt-screen`
- core mechanism
  - launches real Codex front-end with `codex --remote`
  - places a PCODX websocket proxy between the front-end and a real `codex app-server`
  - forwards native front-end app-server methods such as `review/start`
  - forwards native `/compact` as app-server `thread/compact/start`
  - injects PCODX dynamic tools into `thread/start`
  - handles `partial_compact` tool calls inside the proxy
  - after successful PCODX compaction, starts the next upstream app-server turn on a fresh thread
  - injects only the compacted `WrapperLedger` render before that next `turn/start`
- effect
  - native Codex front-end owns slash-command parsing, TUI rendering, approval UX, status, and history UI
  - PCODX owns future model-visible context replacement at the app-server boundary
  - non-compacting turns record completed native Codex items such as command executions, file changes, MCP calls, and web search into the ledger
  - `thread/resume` and `thread/fork` mappings are registered and can continue through the proxy
  - detached review thread mappings are registered and can continue through the proxy
  - review starts refresh and inject compacted context when a prior PCODX compaction invalidated the mapped thread
  - successful PCODX compaction invalidates every mapped thread's injected context because the ledger is global
  - stock Codex hidden transcript is not mutated in place
  - exact remaining blocker
    - Codex `thread/resume` and `thread/fork` params do not accept `dynamicTools`
    - PCODX dynamic tools can be injected on proxy-started fresh threads
    - they cannot be retroactively added to already-resumed native threads without a Codex API extension
- verification
  - `bun run smoke:frontend-proxy`
  - fake upstream app-server confirms `review/start` and `thread/compact/start` forwarding
  - fake upstream confirms dynamic tool advertisement, detached review/resume/fork mapping, native completed-item retention, and all-thread invalidation
  - fake upstream confirms the second injected context contains the compaction summary and omits raw compacted-away sentinels
  - `bun run verify:self-compaction` includes this smoke

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
