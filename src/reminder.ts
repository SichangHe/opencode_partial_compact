import type { Part } from "@opencode-ai/sdk"
import { applyCompactions } from "./hook.js"
import { debugLog } from "./log.js"
import { loadState, recordReminder } from "./state.js"
import { partialCompactInstructionPointer, partialCompactReminderExcerpt } from "./instructions.js"
import { loadPrompt, renderPrompt } from "./prompt-loader.js"
import { currentSessionMessageIDReference } from "./message-ids.js"

type Message = { info: { id: string; sessionID: string }; parts: Part[] }
type ModelLike = { limit?: { context?: number } }

export type ReminderConfig = {
  reminder_enabled: boolean
  reminder_interval_tokens: number
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

function pctText(tokenEstimate: number, model: ModelLike | undefined): string {
  const limit = model?.limit?.context
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return `estimated visible context: ~${tokenEstimate} tokens`
  }
  const pct = Math.min(999, Math.round((tokenEstimate / limit) * 100))
  return `estimated visible context: ~${tokenEstimate}/${limit} tokens (${pct}% of the context window)`
}

function effectiveReminderInterval(configuredInterval: number, model: ModelLike | undefined): number {
  const limit = model?.limit?.context
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0 || limit >= configuredInterval) {
    return configuredInterval
  }
  return Math.max(1, Math.floor(limit * 0.8))
}

export function reminderText(input: { tokenEstimate: number; model?: ModelLike }): string {
  return renderPrompt(loadPrompt("partial-compact-reminder.md"), {
    CONTEXT_STATUS: pctText(input.tokenEstimate, input.model),
    REMINDER_EXCERPT: partialCompactReminderExcerpt(),
    INSTRUCTION_POINTER: partialCompactInstructionPointer(),
    INSTRUCTION_NAME: "opencode-partial-compact",
  }).replace(/\n+/g, " ")
}

export function reminderTextWithMessageIDs(input: {
  sessionID: string
  tokenEstimate: number
  messages: readonly Message[]
  model?: ModelLike
}): string {
  return [
    reminderText(input),
    currentSessionMessageIDReference(input.sessionID, input.messages),
  ].join("\n\n")
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
  const configuredInterval = input.cfg.reminder_interval_tokens
  if (!Number.isFinite(configuredInterval) || configuredInterval <= 0) return
  const interval = effectiveReminderInterval(configuredInterval, input.model)
  const state = await loadState(input.sessionID)
  const visible = input.messages.map(msg => ({ info: msg.info, parts: [...msg.parts] }))
  applyCompactions(visible, state.compactions)
  const tokenEstimate = estimateVisibleTokens(visible)
  const lastEstimate = state.last_reminder?.visible_token_estimate ?? 0
  const messageID = input.messages.at(-1)?.info.id
  if (tokenEstimate < lastEstimate && messageID) {
    await recordReminder(input.sessionID, {
      visible_token_estimate: tokenEstimate,
      message_id: messageID,
      created_at_iso: new Date().toISOString(),
    })
    return
  }
  if (tokenEstimate < interval) return
  if (tokenEstimate - lastEstimate < interval) return
  input.output.system.push(reminderTextWithMessageIDs({
    sessionID: input.sessionID,
    tokenEstimate,
    messages: visible,
    ...(input.model ? { model: input.model } : {}),
  }))
  if (!messageID) return
  await recordReminder(input.sessionID, {
    visible_token_estimate: tokenEstimate,
    message_id: messageID,
    created_at_iso: new Date().toISOString(),
  })
  debugLog(`partial_compact reminder injected: session=${input.sessionID} visible_tokens≈${tokenEstimate}`)
}
