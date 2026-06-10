export type MessageRole = "system" | "user" | "assistant" | "tool"

export type LedgerMessage = {
  id: string
  role: MessageRole
  text: string
  created_at_iso: string
  source?: string
}

export type CompactionRecord = {
  id: string
  from_message_id: string
  to_message_id: string
  summary: string
  created_at_iso: string
  n_messages_replaced: number
}

export type VisibleEntry =
  | { kind: "message"; message: LedgerMessage }
  | { kind: "compaction"; record: CompactionRecord }

export type PartialCompactArgs = {
  from_message_id: string
  to_message_id: string
  summary: string
}

export type PartialCompactResult = {
  ok: true
  record: CompactionRecord
  visible_message_ids: string[]
} | {
  ok: false
  error: string
}

export type AgentToolCall =
  | { name: "read_file"; args: { path: string } }
  | { name: "current_message_ids"; args: Record<string, never> }
  | { name: "partial_compact"; args: PartialCompactArgs }

export type AgentTurnInput = {
  session_id: string
  visible_context: string
  visible_entries: VisibleEntry[]
}

export type AgentTurnOutput = {
  assistant_text: string
  tool_calls: AgentToolCall[]
}

export type AgentAdapter = {
  runTurn(input: AgentTurnInput): Promise<AgentTurnOutput>
}
