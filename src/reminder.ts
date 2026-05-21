import type { Part } from "@opencode-ai/sdk"
import { applyCompactions } from "./hook.js"
import { debugLog } from "./log.js"
import { loadState, recordReminder } from "./state.js"

type Message = { info: { id: string; sessionID: string }; parts: Part[] }
type ModelLike = { limit?: { context?: number } }

export type ReminderConfig = {
  reminder_enabled: boolean
  reminder_context_fraction: number
  reminder_min_tokens: number
}

type EstPart = {
  type: string
  text?: string
  tool?: string
  state?: { status?: string; input?: unknown; output?: string; error?: string }
  synthetic?: boolean
}

function compactPart(part: Part): EstPart {
  if (part.type === "text") {
    return part.synthetic === undefined
      ? { type: part.type, text: part.text }
      : { type: part.type, text: part.text, synthetic: part.synthetic }
  }
  if (part.type === "tool") {
    const state: NonNullable<EstPart["state"]> = {
      status: part.state.status,
      input: part.state.input,
    }
    if (part.state.status === "completed") state.output = part.state.output
    if (part.state.status === "error") state.error = part.state.error
    return {
      type: part.type,
      tool: part.tool,
      state,
    }
  }
  return { type: part.type }
}

export function estimateVisibleTokens(messages: readonly Message[]): number {
  const compact = messages.map(msg => ({ message_id: msg.info.id, parts: msg.parts.map(compactPart) }))
  return Math.ceil(JSON.stringify(compact).length / 4)
}

export function reminderText(): string {
  return [
    "Partial compaction reminder: do you need to remember everything currently in your context window?",
    "If not, consider calling `partial_compact` on no-longer-needed ranges such as bulky tool output, resolved detours, failed edit/debug loops, or obsolete file reads.",
    "Replace them with a clear, succinct summary that preserves only decisions, file paths, errors, assumptions, and outcomes needed later.",
  ].join(" ")
}

function contextLimit(model: ModelLike): number | null {
  const limit = model.limit?.context
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : null
}

export async function maybeInjectReminder(input: {
  sessionID: string
  model?: ModelLike
  output: { system: string[] }
  messages: readonly Message[]
  cfg: ReminderConfig
}): Promise<void> {
  if (!input.cfg.reminder_enabled) return
  if (input.messages.length === 0) return
  const limit = input.model ? contextLimit(input.model) : null
  const interval = Math.max(
    input.cfg.reminder_min_tokens,
    Math.floor((limit ?? input.cfg.reminder_min_tokens * 10) * input.cfg.reminder_context_fraction),
  )
  const state = await loadState(input.sessionID)
  const visible = input.messages.map(msg => ({ info: msg.info, parts: [...msg.parts] }))
  applyCompactions(visible, state.compactions)
  const tokenEstimate = estimateVisibleTokens(visible)
  const lastEstimate = state.last_reminder?.visible_token_estimate ?? 0
  if (tokenEstimate < interval) return
  if (tokenEstimate - lastEstimate < interval) return
  input.output.system.push(reminderText())
  const messageID = input.messages.at(-1)?.info.id
  if (!messageID) return
  await recordReminder(input.sessionID, {
    visible_token_estimate: tokenEstimate,
    message_id: messageID,
    created_at_iso: new Date().toISOString(),
  })
  debugLog(`partial_compact reminder injected: session=${input.sessionID} visible_tokens≈${tokenEstimate}`)
}
