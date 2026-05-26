import { tool } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"
import { validateRanges, type CompactionRangeInput, type ValidationError } from "./validate.js"
import { addCompactions, loadState, recordReminder } from "./state.js"
import { debugLog } from "./log.js"
import { partialCompactInstructionBlock, partialCompactInstructionPointer } from "./instructions.js"
import { loadPrompt, renderPrompt } from "./prompt-loader.js"
import { currentSessionMessageIDReference } from "./message-ids.js"
import { applyCompactions } from "./hook.js"
import { estimateVisibleTokens } from "./reminder.js"

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

function requestedSessionID(range: CompactionRangeInput): string | null {
  if (nonEmptyString(range.target_session_id)) return range.target_session_id
  if (nonEmptyString(range.session_id)) return range.session_id
  return null
}

function targetSessionID(range: CompactionRangeInput, currentSessionID: string): string {
  return requestedSessionID(range) ?? currentSessionID
}

function hasConflictingTargetSessionIDs(range: CompactionRangeInput): boolean {
  return nonEmptyString(range.target_session_id) &&
    nonEmptyString(range.session_id) &&
    range.target_session_id !== range.session_id
}

function targetsAnotherSession(range: CompactionRangeInput, currentSessionID: string): boolean {
  const requested = requestedSessionID(range)
  return requested !== null && requested !== currentSessionID
}

async function recordPostCompactionReminderBaseline(
  sessionID: string,
  messages: Messages,
): Promise<void> {
  const visible = messages.map(msg => ({ info: msg.info, parts: [...msg.parts] }))
  applyCompactions(visible, (await loadState(sessionID)).compactions)
  const messageID = messages.at(-1)?.info.id
  if (!messageID) return
  await recordReminder(sessionID, {
    visible_token_estimate: estimateVisibleTokens(visible),
    message_id: messageID,
    created_at_iso: new Date().toISOString(),
  })
}

export function buildInstructionTool() {
  return tool({
    description: renderPrompt(loadPrompt("partial-compact-instruction-tool-description.md"), {
      INSTRUCTION_POINTER: partialCompactInstructionPointer(),
    }),
    args: {},
    async execute() {
      return partialCompactInstructionBlock()
    },
  })
}

export function buildInstructionToolWithClient(_client: CompactToolClient) {
  return buildInstructionTool()
}

export function buildCurrentSessionMessageIDsTool() {
  return tool({
    description: loadPrompt("current-session-message-ids-tool-description.md"),
    args: {},
    async execute(_args, ctx) {
      return currentSessionMessageIDReference(ctx.sessionID, [])
    },
  })
}

export function buildCurrentSessionMessageIDsToolWithClient(client: CompactToolClient) {
  return tool({
    description: loadPrompt("current-session-message-ids-tool-description.md"),
    args: {},
    async execute(_args, ctx) {
      try {
        const resp = await client.session.messages({
          path: { id: ctx.sessionID },
          throwOnError: true,
        })
        const visible = (resp.data ?? []).map(msg => ({ info: msg.info, parts: [...msg.parts] }))
        applyCompactions(visible, (await loadState(ctx.sessionID)).compactions)
        return currentSessionMessageIDReference(ctx.sessionID, visible)
      } catch (err) {
        debugLog(`partial_compact_current_session_message_ids could not load message IDs for ${ctx.sessionID}: ${String(err)}`)
        return currentSessionMessageIDReference(ctx.sessionID, [])
      }
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
      renderPrompt(loadPrompt("partial-compact-tool-description.md"), {
        INSTRUCTION_POINTER: partialCompactInstructionPointer(),
      }),
    args: {
      ranges: tool.schema
        .array(tool.schema.object({
          from_message_id: tool.schema.string().describe(loadPrompt("partial-compact-range-from-message-id.md")),
          to_message_id: tool.schema.string().describe(loadPrompt("partial-compact-range-to-message-id.md")),
          summary: tool.schema.string().describe(loadPrompt("partial-compact-range-summary.md")),
        }).passthrough())
        .describe(
          loadPrompt("partial-compact-arg-ranges.md"),
        ),
    },

    async execute(args, ctx) {
      if (!cfg.enabled) {
        return JSON.stringify({ error: "opencode-partial-compact is disabled via config" })
      }

      const sessionID = ctx.sessionID
      const requestedRanges = ((args.ranges ?? []) as CompactionRangeInput[]).filter(range =>
        nonEmptyString(range.from_message_id) || nonEmptyString(range.to_message_id) || nonEmptyString(range.summary) || nonEmptyString(range.target_session_id) || nonEmptyString(range.session_id),
      )
      if (requestedRanges.length === 0) {
        return JSON.stringify({ error: "provide ranges with at least one complete range" })
      }
      const missingRequired = requestedRanges.some(range =>
        !nonEmptyString(range.from_message_id) || !nonEmptyString(range.to_message_id) || !nonEmptyString(range.summary)
      )
      if (missingRequired) {
        return JSON.stringify({ error: "each range must include from_message_id, to_message_id, and summary" })
      }
      if (requestedRanges.some(hasConflictingTargetSessionIDs)) {
        return JSON.stringify({ error: "target_session_id and legacy session_id must match when both are provided" })
      }
      if (requestedRanges.some(range => targetsAnotherSession(range, sessionID))) {
        return JSON.stringify({ error: "partial_compact can only compact message ranges in the current session; omit session selectors" })
      }

      debugLog(`partial_compact called: ranges=${requestedRanges.length} session=${sessionID}`)

      const normalizedRanges: NormalizedCompactionRange[] = requestedRanges.map(range => {
        const truncated = truncateSummary(range.summary, cfg.max_summary_chars)
        return { ...range, session_id: targetSessionID(range, sessionID), summary: truncated.summary, truncated: truncated.truncated }
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
            note: "All ranges are prevalidated before writes. Persistence is atomic for the current session sidecar.",
          })
        }
        try {
          await recordPostCompactionReminderBaseline(targetSessionID, messagesBySession.get(targetSessionID) ?? [])
        } catch (err) {
          debugLog(`Compaction persisted but reminder baseline update failed for ${targetSessionID}: ${String(err)}`)
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
