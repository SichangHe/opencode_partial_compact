import type { Part } from "@opencode-ai/sdk"

export type WithParts = {
  info: { id: string; sessionID: string }
  parts: Part[]
}

export type CompactionRecord = {
  from_message_id: string
  to_message_id: string
  summary: string
  created_at_iso: string
}

/** Pure range-validation errors. */
export type ValidationError =
  | { kind: "not_found"; id: string }
  | { kind: "overlaps"; from_message_id: string }
  | { kind: "prior_compaction" }
  | { kind: "tool_pair_split"; at: string; extend_to?: string; trim_to?: string }

/**
 * Return true if the message has any ToolPart in an incomplete (pending/running) state.
 * Such a part represents a tool_use whose tool_result hasn't arrived yet.
 */
function hasIncompleteToolUse(msg: WithParts): boolean {
  return msg.parts.some(
    p => p.type === "tool" && ((p as { state?: { status?: string } }).state?.status === "pending" || (p as { state?: { status?: string } }).state?.status === "running"),
  )
}

/**
 * Return true if the message has any ToolPart in a completed/error state.
 * Such a part represents a tool_result (the result side of a pair).
 */
function hasToolResult(msg: WithParts): boolean {
  return msg.parts.some(
    p => p.type === "tool" && ((p as { state?: { status?: string } }).state?.status === "completed" || (p as { state?: { status?: string } }).state?.status === "error"),
  )
}

/**
 * Validate a proposed compaction range against the current view and active records.
 * Returns null on success, or a ValidationError on the first failure.
 *
 * All checks are pure (no I/O). The caller supplies the full sorted message list
 * and active compaction records.
 */
export function validateRange(
  from_message_id: string,
  to_message_id: string,
  messages: WithParts[],
  records: CompactionRecord[],
): ValidationError | null {
  const fromIdx = messages.findIndex(m => m.info.id === from_message_id)
  if (fromIdx === -1) return { kind: "not_found", id: from_message_id }

  const toIdx = messages.findIndex(m => m.info.id === to_message_id)
  if (toIdx === -1) return { kind: "not_found", id: to_message_id }

  if (fromIdx > toIdx) {
    // from must not be after to — treat as bad from_message_id
    return { kind: "not_found", id: from_message_id }
  }

  const lo = fromIdx
  const hi = toIdx

  // Check overlap with active compaction records
  for (const rec of records) {
    const recFromIdx = messages.findIndex(m => m.info.id === rec.from_message_id)
    const recToIdx = messages.findIndex(m => m.info.id === rec.to_message_id)
    if (recFromIdx === -1 || recToIdx === -1) continue
    const recLo = Math.min(recFromIdx, recToIdx)
    const recHi = Math.max(recFromIdx, recToIdx)
    if (lo <= recHi && hi >= recLo) {
      return { kind: "overlaps", from_message_id: rec.from_message_id }
    }
  }

  // Check for our own synthetic compaction parts inside the range
  for (let i = lo; i <= hi; i++) {
    const msg = messages[i]
    if (!msg) continue
    for (const part of msg.parts) {
      if (
        part.type === "text" &&
        (part as { source?: string }).source === "opencode-partial-compact"
      ) {
        return { kind: "prior_compaction" }
      }
    }
  }

  // Check tool-pair split at the upper boundary:
  // If the last message in the range has an incomplete tool_use, its result is
  // in the next message — cutting here would orphan the pair.
  const lastInRange = messages[hi]
  const afterRange = messages[hi + 1]
  if (lastInRange && afterRange && hasIncompleteToolUse(lastInRange)) {
    return {
      kind: "tool_pair_split",
      at: lastInRange.info.id,
      extend_to: afterRange.info.id,
    }
  }

  // Check tool-pair split at the lower boundary:
  // If the message just before the range has an incomplete tool_use, the result
  // may be inside the range — cutting from here would orphan the pair.
  const beforeRange = messages[lo - 1]
  const firstInRange = messages[lo]
  if (beforeRange && firstInRange && hasIncompleteToolUse(beforeRange) && hasToolResult(firstInRange)) {
    return {
      kind: "tool_pair_split",
      at: firstInRange.info.id,
      trim_to: beforeRange.info.id,
    }
  }

  return null
}
