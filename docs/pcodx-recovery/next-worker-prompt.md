# next implementation-worker prompt

prompt

You are the PCODX implementation worker. Use normal Codex for code editing.
Run `~/.config/getagentsmd` first and follow it. A stock Codex worker launch is
not acceptance evidence for the redesigned PCODX runtime; acceptance requires
the app-server controller path below.

Task: reimplement PCODX recovery around controller-owned app-server-visible
shrink. Do not treat MCP sidecar ledger compaction as success. The success
criterion is observable shrinkage of the real Codex app-server model-visible
context through `thread/tokenUsage/updated` `last.inputTokens` before and after
compaction.

Controller launch route to make primary:

- manager launch wrapper
  - from `experiments/codex-wrapper`
  - command template
    - `bun run manager:agent --`
    - `--task-file <task-file>`
    - `--root <work-log-root>`
    - `--tmux-session <tmux-session>`
    - `--workdir /ssd1/sichangheagent/opencode_partial_compact`
- continuation route
  - use the emitted `continue_command`
  - preserve the emitted `run_dir` and `session_id`
- non-acceptance route
  - stock Codex plus MCP-only tools may edit code
  - it cannot prove redesigned PCODX context shrink

Read first:

- `docs/pcodx-recovery/README.md`
- `docs/pcodx-recovery/current-implementation.md`
- `docs/pcodx-recovery/critique-and-redesign.md`
- `docs/pcodx-recovery/retain-quarantine.md`
- `experiments/codex-wrapper/README.md`

Implement under supervision:

- make the app-server controller path the primary PCODX worker path
  - use `experiments/codex-wrapper/src/self-compacting-controller.ts`
  - use `experiments/codex-wrapper/src/controller-cli.ts`
  - use `experiments/codex-wrapper/src/manager-agent-launch.ts`
- preserve and harden the controller ledger render path
  - future turns must be seeded from `renderVisibleContext`
  - dynamic `partial_compact` must affect the next controller-started turn
  - raw compacted-away text must not be reintroduced after compaction
- keep MCP-only sidecar functionality clearly labelled as non-native
  - every MCP receipt must keep or strengthen `native_context_rewritten: false`
  - no docs, prompts, or reports may imply stock CLI transcript shrink
    from MCP-only tools
- add or update verifier scripts so acceptance checks are one command
  - include typecheck and unit tests
  - include app-server context-shrink smoke
  - include self-compacting controller smoke
  - include controller CLI smoke
  - emit raw input tokens, compacted input tokens, shrink tokens,
    shrink fraction, and artifact paths
- update docs only after code behavior is true
  - describe controller-owned app-server next-turn shrink
  - describe MCP-only path as sidecar memory

Acceptance checks:

- a bulky raw context baseline turn reports `last.inputTokens`
- raw sentinel text is present in the baseline turn's actual
  `model_visible_context_path`
- after controller compaction, the next controller-started Codex turn reports
  materially lower `last.inputTokens`
- compacted-away raw sentinel text is absent from the follow-up turn's actual
  `model_visible_context_path`
- compacted summary text is present in that next context
- token metrics come from those same two app-server turns
- generated report records before and after token metrics and paths
- MCP-only tests cannot be used as evidence of controller-owned app-server shrink
- normal repo checks pass

Report back through the manager, not directly to the supervisor. Include:

- files changed
- exact verifier command and result
- token shrink metrics
- artifact paths
- whether the current worker was launched through the app-server controller or
  stock Codex
- any remaining gap between controller-owned app-server next-turn shrink and
  live stock CLI transcript shrink
