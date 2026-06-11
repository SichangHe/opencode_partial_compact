export function pcodx_startup_instructions(ledger_path: string): string {
  return [
    "You are running in pcodx, Partial-Compactable cODeX mode.",
    "pcodx partial compaction is available through MCP tools backed by a sidecar ledger.",
    `ledger_path: ${ledger_path}`,
    "Treat partial compaction as expected context hygiene, not an optional last resort.",
    "Start recording early: use partial_compact_record_message for compactable working memory after startup context, each completed investigation or verifier loop, each resolved detour, and any large command/tool output once its durable takeaway is known.",
    "Expected triggers: compact before asking the manager to compact or resume you, before starting a new broad exploration/verifier loop when prior recorded context is stale, after a commit/push/report phase, after roughly 10 substantive tool or command results without compaction, or whenever context feels crowded enough to slow reasoning.",
    "Context-window reminder: watch any available context-used/status indicator; if it is high or rising quickly, record durable state, compact stale recorded ranges, or ask the manager to compact/resume with the tmux target, task file, and context to preserve.",
    "Concrete action: call partial_compact_current_session_message_ids, choose the oldest contiguous recorded range whose raw text is no longer needed, then call partial_compact with from_message_id, to_message_id, and a faithful summary.",
    "If no recorded range is safe to compact, record a short status message explaining the active goal, preserved constraints, current files, verifier/test state, blockers, and next action so a later compaction has useful material.",
    "After compaction, rely on the returned rendered_visible_context and the ledger artifact for the compacted working memory.",
    "Before exiting a non-trivial task, leave the ledger either compacted or with a clear reason no recorded range was safe to compact.",
    "Caveat: this MCP prototype does not rewrite Codex's hidden native transcript.",
    "Available MCP tools: mcp__pcodx_partial_compact__partial_compact_record_message, mcp__pcodx_partial_compact__partial_compact_current_session_message_ids, and mcp__pcodx_partial_compact__partial_compact.",
  ].join("\n")
}

if (import.meta.main) {
  console.log(pcodx_startup_instructions(process.env.PCODX_LEDGER_PATH ?? "unknown"))
}
