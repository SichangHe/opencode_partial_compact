import type { Part } from "@opencode-ai/sdk"
import { getCompactionsSync, replaceCompactions, warmCache } from "./state.js"
import { debugLog } from "./log.js"
import type { CompactionRecord } from "./validate.js"

type WithParts = {
  info: { id: string; sessionID: string }
  parts: Part[]
}

export type MessagesTransformOptions = {
  resolveSessionMessageIDs?: (sessionID: string) => Promise<ReadonlySet<string>>
}

export type ApplyCompactionsResult = {
  applied: CompactionRecord[]
  skipped: CompactionRecord[]
}

/**
 * Build the deterministic synthetic text for a compaction record.
 * Byte-stable: depends only on the record fields, never on timestamps or random data.
 */
export function syntheticText(rec: CompactionRecord): string {
  const session = rec.session_id ? `session ${rec.session_id}: ` : ""
  return `[compacted: ${session}${rec.from_message_id}..${rec.to_message_id} — ${rec.summary}]`
}

/**
 * Build the deterministic part ID for a compaction record.
 * Never uses timestamps or UUIDs.
 */
export function syntheticPartId(rec: CompactionRecord): string {
  return `pc_${rec.from_message_id}`
}

/**
 * Apply compaction records to the in-memory message array.
 * Mutates `messages` in place — drops collapsed messages and attaches synthetic parts.
 * Sorted by from_message_id ascending (guaranteed by state.ts insert order).
 */
export function applyCompactions(
  messages: WithParts[],
  records: CompactionRecord[],
): ApplyCompactionsResult {
  // Process in reverse order so index positions remain valid as we splice
  // But we need ascending order for correctness per spec; process from last to first
  // so that splicing earlier indices doesn't affect later ones we haven't processed.
  // Actually: process ascending but track the offset introduced by previous splices.
  // Simpler: collect indices to remove and do one pass.

  const toRemove = new Set<number>()
  const applied: CompactionRecord[] = []
  const skipped: CompactionRecord[] = []

  for (const rec of records) {
    const fromIdx = messages.findIndex(m => m.info.id === rec.from_message_id)
    if (fromIdx === -1) {
      debugLog(`Skipping unresolvable compaction record ${rec.from_message_id} (message not in view)`)
      skipped.push(rec)
      continue
    }
    const toIdx = messages.findIndex(m => m.info.id === rec.to_message_id)
    if (toIdx === -1) {
      debugLog(`Skipping unresolvable compaction record ${rec.to_message_id} (to message not in view)`)
      skipped.push(rec)
      continue
    }
    applied.push(rec)

    const lo = Math.min(fromIdx, toIdx)
    const hi = Math.max(fromIdx, toIdx)

    // Drop all parts in the first (surviving) message and replace with synthetic
    const first = messages[lo]
    if (!first) continue

    first.parts = [
      {
        id: syntheticPartId(rec),
        sessionID: first.info.sessionID,
        messageID: first.info.id,
        type: "text",
        text: syntheticText(rec),
        synthetic: true,
        // source is not a standard TextPart field but we cast via metadata or extra property
      } as Part & { source: string },
    ]
    // Attach our source marker via type assertion (TextPart allows extra metadata)
    ;(first.parts[0] as { source?: string }).source = "opencode-partial-compact"

    // Mark interior messages for removal
    for (let i = lo + 1; i <= hi; i++) {
      toRemove.add(i)
    }
  }

  // Remove marked indices (in reverse to keep positions stable)
  const sortedRemove = Array.from(toRemove).sort((a, b) => b - a)
  for (const idx of sortedRemove) {
    messages.splice(idx, 1)
  }
  return { applied, skipped }
}

function hasNativeCompactionPart(messages: WithParts[]): boolean {
  return messages.some(msg => msg.parts.some(part => part.type === "compaction"))
}

/**
 * The `experimental.chat.messages.transform` hook handler.
 */
export async function messagesTransformHandler(
  _input: object,
  output: { messages: WithParts[] },
  options: MessagesTransformOptions = {},
): Promise<void> {
  if (output.messages.length === 0) return

  const sessionID = output.messages[0]?.info.sessionID
  if (!sessionID) return

  await warmCache(sessionID)
  const records = getCompactionsSync(sessionID)
  debugLog(`messages.transform fired — session=${sessionID} messages=${output.messages.length} active_records=${records.length}`)
  if (records.length === 0) return

  const result = applyCompactions(output.messages, records)
  if (result.skipped.length > 0 && hasNativeCompactionPart(output.messages)) {
    if (!options.resolveSessionMessageIDs) {
      debugLog("Skipped compaction records after native compaction, but no full-session resolver is available; not pruning")
      return
    }
    let fullMessageIDs: ReadonlySet<string>
    try {
      fullMessageIDs = await options.resolveSessionMessageIDs(sessionID)
    } catch (err) {
      debugLog(`Skipped pruning stale compaction records — failed to fetch full session messages: ${String(err)}`)
      return
    }
    const stale = new Set(
      result.skipped
        .filter(rec => !fullMessageIDs.has(rec.from_message_id) && !fullMessageIDs.has(rec.to_message_id))
        .map(rec => `${rec.from_message_id}::${rec.to_message_id}`),
    )
    if (stale.size === 0) return
    const kept = records.filter(rec => !stale.has(`${rec.from_message_id}::${rec.to_message_id}`))
    debugLog(`Pruning ${stale.size} stale compaction record(s) after native compaction`)
    await replaceCompactions(sessionID, kept)
  }
}
