import { tool } from "@opencode-ai/plugin"
import type { PluginInput } from "@opencode-ai/plugin"
import { validateRange } from "./validate.js"
import { addCompaction, loadState } from "./state.js"
import { debugLog } from "./log.js"

export type PluginConfig = {
  enabled: boolean
  max_summary_chars: number
  debug_log_path: string | null
  reminder_enabled: boolean
  reminder_context_fraction: number
  reminder_min_tokens: number
}

/**
 * Build and return the `partial_compact` tool definition.
 * Captures the plugin client and config at construction time.
 */
export function buildCompactTool(
  client: PluginInput["client"],
  cfg: PluginConfig,
) {
  return tool({
    description:
      "Replace a contiguous range of past messages in your context with a single summary you write. Ask yourself: do you need to remember everything currently in your context window? If not, use this tool to replace no-longer-needed parts — bulky tool output, resolved detours, failed edit/debug loops, obsolete file reads, or one-off investigation logs — with a clear and succinct summary. The originals stay in the session log but are removed from your working view.\n\nPrefer compacting RECENT unneeded content over rewriting deep history. Compacting the middle of history invalidates prompt cache; tail-region compactions are near-free. After a phase stabilizes, proactively compact raw logs/details and keep only decisions, file paths, errors, assumptions, and outcomes needed later.\n\nThe summary will replace the entire range — write it like a note to your future self: state what happened, what's relevant, and reference file names / tool names you may want to recall.",
    args: {
      from_message_id: tool.schema
        .string()
        .describe("Starting message ID (msg...). Inclusive."),
      to_message_id: tool.schema
        .string()
        .describe("Ending message ID (msg...). Inclusive. May equal from_message_id."),
      summary: tool.schema
        .string()
        .describe(
          `Concise replacement text. Hard cap: max_summary_chars (default ${cfg.max_summary_chars}). Truncation reported in tool result.`,
        ),
    },

    async execute(args, ctx) {
      if (!cfg.enabled) {
        return JSON.stringify({ error: "opencode-partial-compact is disabled via config" })
      }

      const { from_message_id, to_message_id } = args
      let { summary } = args
      const sessionID = ctx.sessionID

      debugLog(`partial_compact called: from=${from_message_id} to=${to_message_id} session=${sessionID}`)

      // Truncate summary if over cap
      let truncated = false
      if (summary.length > cfg.max_summary_chars) {
        summary = summary.slice(0, cfg.max_summary_chars) + "[...truncated]"
        truncated = true
      }

      // Load all messages for this session to validate the range
      let messages: Array<{ info: { id: string; sessionID: string }; parts: import("@opencode-ai/sdk").Part[] }>
      try {
        const resp = await client.session.messages({
          path: { id: sessionID },
          throwOnError: true,
        })
        messages = resp.data ?? []
      } catch (err) {
        debugLog(`Failed to fetch session messages: ${String(err)}`)
        return JSON.stringify({ error: `Failed to fetch session messages: ${String(err)}` })
      }

      // Load existing compaction records for overlap check
      const state = await loadState(sessionID)
      const records = state.compactions

      const validationErr = validateRange(from_message_id, to_message_id, messages, records)
      if (validationErr) {
        let errMsg: string
        switch (validationErr.kind) {
          case "not_found":
            errMsg = `message ${validationErr.id} not found in this session`
            break
          case "overlaps":
            errMsg = `range overlaps compaction starting at ${validationErr.from_message_id}`
            break
          case "prior_compaction":
            errMsg = "range includes a prior compaction; cannot compact a compacted region"
            break
          case "tool_pair_split": {
            const hint = validationErr.extend_to
              ? `extend the range to ${validationErr.extend_to}`
              : `trim to ${validationErr.trim_to ?? "previous message"}`
            errMsg = `range splits a tool_use/tool_result pair at ${validationErr.at} — ${hint}`
            break
          }
        }
        debugLog(`Validation error: ${errMsg}`)
        return JSON.stringify({ error: errMsg })
      }

      // Count messages replaced
      const fromIdx = messages.findIndex(m => m.info.id === from_message_id)
      const toIdx = messages.findIndex(m => m.info.id === to_message_id)
      const n_messages_replaced = toIdx - fromIdx + 1

      // Persist the compaction record
      const record = {
        from_message_id,
        to_message_id,
        summary,
        created_at_iso: new Date().toISOString(),
        n_messages_replaced,
      }
      const active_compactions = records.length + 1
      const total_known_messages_replaced = records
        .reduce((sum, rec) => sum + (rec.n_messages_replaced ?? 0), n_messages_replaced)
      await addCompaction(sessionID, record)

      debugLog(`Compaction recorded: ${from_message_id}..${to_message_id}, ${n_messages_replaced} messages`)

      return JSON.stringify({
        n_messages_replaced,
        truncated,
        active_compactions,
        total_known_messages_replaced,
        note: "The compacted range is removed from the model-visible view on subsequent calls; the original session log is unchanged.",
      })
    },
  })
}
