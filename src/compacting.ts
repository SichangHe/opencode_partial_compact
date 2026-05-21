import { loadState } from "./state.js"
import type { CompactionRecord } from "./validate.js"

export function nativeCompactionContext(records: CompactionRecord[]): string | null {
  if (records.length === 0) return null
  const lines = records.map(rec =>
    `- ${rec.from_message_id}..${rec.to_message_id}: ${rec.summary}`,
  )
  return [
    "Existing partial compactions from opencode-partial-compact:",
    ...lines,
    "Preserve these summaries in the native compaction result; the original ranges may already be absent from the model-visible view.",
  ].join("\n")
}

export async function sessionCompactingHandler(
  input: { sessionID: string },
  output: { context: string[]; prompt?: string },
): Promise<void> {
  const state = await loadState(input.sessionID)
  const context = nativeCompactionContext(state.compactions)
  if (context) output.context.push(context)
}
