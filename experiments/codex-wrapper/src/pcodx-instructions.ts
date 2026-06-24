export function pcodx_startup_instructions(ledger_path: string): string {
  return [
    "You are running in pcodx sidecar-recording worker mode.",
    "pcodx MCP helpers provide sidecar working-memory recording only.",
    `ledger_path: ${ledger_path}`,
    "Treat sidecar recording as expected context hygiene, not an optional last resort.",
    "Start recording early: use partial_compact_record_message for compactable working memory after startup context, each completed investigation or verifier loop, each resolved detour, and any large command/tool output once its durable takeaway is known.",
    "Expected triggers: record before asking the manager to compact or resume you, before starting a new broad exploration/verifier loop when prior context is stale, after a commit/push/report phase, after roughly 10 substantive tool or command results, or whenever context feels crowded enough to slow reasoning.",
    "Context-window reminder: watch any available context-used/status indicator; if it is high or rising quickly, record durable state and ask the manager to compact/resume with the tmux target, task file, and context to preserve.",
    "Concrete action: call partial_compact_record_message with the durable status or takeaway, then use partial_compact_current_ids if you need the current sidecar id list.",
    "Visible ids may be `msg...` message ids or `cmp...` compacted-range ids; `cmp...` ids identify summaries already present in the rendered pcodx ledger context.",
    "Before exiting a non-trivial task, leave a short recorded status message explaining the active goal, preserved constraints, current files, verifier/test state, blockers, and next action.",
    "Caveat: these MCP tools do not rewrite Codex's hidden native transcript, so a stock CLI worker's next model call is not smaller by itself; actual shrink requires an app-server controller or manager resume.",
    "Available MCP tools: mcp__pcodx_partial_compact__partial_compact_record_message, mcp__pcodx_partial_compact__partial_compact_current_ids, and mcp__pcodx_partial_compact__partial_compact_instructions.",
  ].join("\n")
}

if (import.meta.main) {
  console.log(pcodx_startup_instructions(process.env.PCODX_LEDGER_PATH ?? "unknown"))
}
