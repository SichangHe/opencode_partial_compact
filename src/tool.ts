import { tool } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"
import { validateRanges, type CompactionRangeInput, type ValidationError } from "./validate.js"
import { addCompactions, loadState } from "./state.js"
import { debugLog } from "./log.js"
import { partialCompactInstructionBlock, partialCompactInstructionPointer } from "./instructions.js"

export type PluginConfig = {
  enabled: boolean
  max_summary_chars: number
  debug_log_path: string | null
  reminder_enabled: boolean
  reminder_interval_tokens: number
}

export type CompactToolClient = {
  session: {
    messages(input: { path: { id: string }; throwOnError: true }): Promise<{
      data?: Array<{ info: { id: string; sessionID: string }; parts: Part[] }>
    }>
  }
}

type Messages = Array<{ info: { id: string; sessionID: string }; parts: Part[] }>

type NormalizedCompactionRange = CompactionRangeInput & {
  session_id: string
  truncated: boolean
}

function validationErrorMessage(validationErr: ValidationError): string {
  switch (validationErr.kind) {
    case "not_found":
      return `message ${validationErr.id} not found in this session`
    case "invalid_order":
      return `from_message_id ${validationErr.from_message_id} must not come after to_message_id ${validationErr.to_message_id}`
    case "overlaps":
      return `range overlaps compaction starting at ${validationErr.from_message_id}`
    case "overlaps_new":
      return `range overlaps another requested range starting at ${validationErr.from_message_id}`
    case "prior_compaction":
      return "range includes a prior compaction; cannot compact a compacted region"
    case "tool_pair_split": {
      const hint = validationErr.extend_to
        ? `extend the range to ${validationErr.extend_to}`
        : `extend the range start back to ${validationErr.extend_from ?? "the tool-use message"} or start after ${validationErr.start_after ?? validationErr.at}`
      return `range splits a tool_use/tool_result pair at ${validationErr.at} — ${hint}`
    }
  }
}

function truncateSummary(summary: string, maxChars: number): { summary: string; truncated: boolean } {
  if (summary.length <= maxChars) return { summary, truncated: false }
  return { summary: summary.slice(0, maxChars) + "[...truncated]", truncated: true }
}

function groupRangesBySession(ranges: NormalizedCompactionRange[]): Map<string, NormalizedCompactionRange[]> {
  const out = new Map<string, NormalizedCompactionRange[]>()
  for (const range of ranges) {
    const current = out.get(range.session_id)
    if (current) current.push(range)
    else out.set(range.session_id, [range])
  }
  return out
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

export function buildInstructionTool() {
  return tool({
    description: `Return the named instruction block for using partial_compact. ${partialCompactInstructionPointer()}`,
    args: {},
    async execute() {
      return partialCompactInstructionBlock()
    },
  })
}

/**
 * Build and return the `partial_compact` tool definition.
 * Captures the plugin client and config at construction time.
 */
export function buildCompactTool(
  client: CompactToolClient,
  cfg: PluginConfig,
) {
  return tool({
    description:
      `${partialCompactInstructionPointer()} Replace one contiguous range, or multiple disjoint ranges with \`ranges\`, using summaries you write. The originals stay in the session log but are removed from your working view. Below ~50% context, still compact after phase boundaries when raw evidence is stale and conclusions are durable; do not wait for pressure unless the next step still needs the verbatim text. Prefer one batch call when compacting multiple stale ranges in the current session to save turns and KV cache.`,
    args: {
      from_message_id: tool.schema
        .string()
        .optional()
        .describe("Starting message ID (msg...). Inclusive. Legacy single-range mode; do not mix with ranges."),
      to_message_id: tool.schema
        .string()
        .optional()
        .describe("Ending message ID (msg...). Inclusive. Legacy single-range mode; do not mix with ranges."),
      summary: tool.schema
        .string()
        .optional()
        .describe(
          `Concise replacement text for legacy single-range mode. Hard cap: max_summary_chars (default ${cfg.max_summary_chars}). Truncation reported in tool result.`,
        ),
      ranges: tool.schema
        .array(tool.schema.object({
          session_id: tool.schema.string().optional().describe("Session ID to compact. Omit for the current session."),
          from_message_id: tool.schema.string().describe("Starting message ID (msg...). Inclusive."),
          to_message_id: tool.schema.string().describe("Ending message ID (msg...). Inclusive. May equal from_message_id."),
          summary: tool.schema.string().describe("Concise replacement text for this range. Mention relevant session IDs and why this range is safe to compact."),
        }))
        .optional()
        .describe(
          "Multiple disjoint ranges to compact in one tool call. Ranges may target the current session or other sessions by session_id. Do not mix with legacy from_message_id/to_message_id/summary fields.",
        ),
    },

    async execute(args, ctx) {
      if (!cfg.enabled) {
        return JSON.stringify({ error: "opencode-partial-compact is disabled via config" })
      }

      const sessionID = ctx.sessionID
      const batchRanges = args.ranges?.filter(range =>
        nonEmptyString(range.from_message_id) || nonEmptyString(range.to_message_id) || nonEmptyString(range.summary) || nonEmptyString(range.session_id),
      ) ?? []
      const hasRanges = batchRanges.length > 0
      const hasLegacy = nonEmptyString(args.from_message_id) || nonEmptyString(args.to_message_id) || nonEmptyString(args.summary)
      if (hasRanges && hasLegacy) {
        return JSON.stringify({ error: "do not mix ranges with from_message_id/to_message_id/summary" })
      }

      const legacyMode = !hasRanges
      let requestedRanges: CompactionRangeInput[]
      if (hasRanges) {
        const missingSummary = batchRanges.some(range => !nonEmptyString(range.summary))
        if (missingSummary) {
          return JSON.stringify({ error: "each range must include from_message_id, to_message_id, and summary" })
        }
        requestedRanges = batchRanges
      } else {
        if (!nonEmptyString(args.from_message_id) || !nonEmptyString(args.to_message_id) || !nonEmptyString(args.summary)) {
          return JSON.stringify({ error: "provide from_message_id, to_message_id, and summary, or provide ranges" })
        }
        requestedRanges = [{
          from_message_id: args.from_message_id,
          to_message_id: args.to_message_id,
          summary: args.summary,
        }]
      }

      debugLog(`partial_compact called: ranges=${requestedRanges.length} session=${sessionID}`)

      const normalizedRanges: NormalizedCompactionRange[] = requestedRanges.map(range => {
        const truncated = truncateSummary(range.summary, cfg.max_summary_chars)
        return { ...range, session_id: nonEmptyString(range.session_id) ? range.session_id : sessionID, summary: truncated.summary, truncated: truncated.truncated }
      })

      const rangesBySession = groupRangesBySession(normalizedRanges)
      const messagesBySession = new Map<string, Messages>()
      const existingRecordsBySession = new Map<string, Awaited<ReturnType<typeof loadState>>["compactions"]>()

      for (const targetSessionID of rangesBySession.keys()) {
        try {
          const resp = await client.session.messages({
            path: { id: targetSessionID },
            throwOnError: true,
          })
          messagesBySession.set(targetSessionID, resp.data ?? [])
        } catch (err) {
          debugLog(`Failed to fetch session messages for ${targetSessionID}: ${String(err)}`)
          return JSON.stringify({ error: `Failed to fetch session ${targetSessionID} messages: ${String(err)}` })
        }
        existingRecordsBySession.set(targetSessionID, (await loadState(targetSessionID)).compactions)
      }

      const validatedBySession = new Map<string, ReturnType<typeof validateRanges>["ranges"]>()
      for (const [targetSessionID, sessionRanges] of rangesBySession) {
        const messages = messagesBySession.get(targetSessionID) ?? []
        const records = existingRecordsBySession.get(targetSessionID) ?? []
        const validation = validateRanges(sessionRanges, messages, records)
        if (validation.error) {
          const errMsg = validationErrorMessage(validation.error)
          debugLog(`Validation error for ${targetSessionID}: ${errMsg}`)
          return JSON.stringify({ error: `session ${targetSessionID}: ${errMsg}` })
        }
        validatedBySession.set(targetSessionID, validation.ranges)
      }

      const createdAt = new Date().toISOString()
      const compactedRanges: Array<{
        session_id: string
        from_message_id: string
        to_message_id: string
        n_messages_replaced: number
        truncated: boolean
      }> = []
      let n_messages_replaced = 0
      let active_compactions = 0
      let total_known_messages_replaced = 0

      for (const [targetSessionID, validatedRanges] of validatedBySession) {
        const compactionRecords = validatedRanges.map(range => ({
          session_id: targetSessionID,
          from_message_id: range.from_message_id,
          to_message_id: range.to_message_id,
          summary: range.summary,
          created_at_iso: createdAt,
          n_messages_replaced: range.n_messages_replaced,
        }))
        const existingRecords = existingRecordsBySession.get(targetSessionID) ?? []
        active_compactions += existingRecords.length + compactionRecords.length
        const sessionMessagesReplaced = compactionRecords.reduce((sum, rec) => sum + (rec.n_messages_replaced ?? 0), 0)
        n_messages_replaced += sessionMessagesReplaced
        total_known_messages_replaced += existingRecords
          .reduce((sum, rec) => sum + (rec.n_messages_replaced ?? 0), sessionMessagesReplaced)
        try {
          await addCompactions(targetSessionID, compactionRecords)
        } catch (err) {
          debugLog(`Failed to persist compactions for ${targetSessionID}: ${String(err)}`)
          return JSON.stringify({
            error: `Failed to persist compactions for session ${targetSessionID}: ${String(err)}`,
            note: "All ranges are prevalidated before writes. Persistence is atomic per target session sidecar; a cross-session batch can report failure after an earlier target session was already written.",
          })
        }

        for (const range of validatedRanges) {
          const normalized = normalizedRanges.find(candidate =>
            candidate.session_id === targetSessionID &&
            candidate.from_message_id === range.from_message_id &&
            candidate.to_message_id === range.to_message_id
          )
          compactedRanges.push({
            session_id: targetSessionID,
            from_message_id: range.from_message_id,
            to_message_id: range.to_message_id,
            n_messages_replaced: range.n_messages_replaced,
            truncated: normalized?.truncated ?? false,
          })
        }
      }

      debugLog(`Compaction recorded: ranges=${compactedRanges.length}, ${n_messages_replaced} messages`)

      if (legacyMode) {
        const only = compactedRanges[0]
        if (!only) return JSON.stringify({ error: "internal error: missing compacted range" })
        return JSON.stringify({
          n_messages_replaced: only.n_messages_replaced,
          truncated: only.truncated,
          active_compactions,
          total_known_messages_replaced,
          session_id: sessionID,
          note: "The compacted range is removed from the model-visible view on subsequent calls; the original session log is unchanged.",
        })
      }

      return JSON.stringify({
        ranges_compacted: compactedRanges,
        n_ranges_compacted: compactedRanges.length,
        n_messages_replaced,
        truncated: normalizedRanges.some(range => range.truncated),
        active_compactions,
        total_known_messages_replaced,
        session_id: sessionID,
        note: "The compacted ranges are removed from the model-visible view on subsequent calls; the original session log is unchanged.",
      })
    },
  })
}
