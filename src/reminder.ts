import type { Part } from "@opencode-ai/sdk"
import { applyCompactions } from "./hook.js"
import { debugLog } from "./log.js"
import { loadState, recordReminder } from "./state.js"
import { loadPrompt, renderPrompt } from "./prompt-loader.js"
import { currentSessionMessageIDReference } from "./message-ids.js"

type Message = { info: { id: string; sessionID: string }; parts: Part[] }
type ModelLike = { limit?: { context?: number; input?: number; output?: number } }

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

export function effectiveLimit(model: ModelLike | undefined): number | null {
  const candidates = [model?.limit?.input, model?.limit?.context]
    .filter((limit): limit is number => typeof limit === "number" && Number.isFinite(limit) && limit > 0)
  if (candidates.length === 0) return null
  return Math.min(...candidates)
}

function usageLevel(tokenEstimate: number, model: ModelLike | undefined): "unknown" | "routine" | "high" | "urgent" | "critical" {
  const limit = effectiveLimit(model)
  if (!limit) return "unknown"
  const ratio = tokenEstimate / limit
  if (ratio >= 0.9) return "critical"
  if (ratio >= 0.8) return "urgent"
  if (ratio >= 0.5) return "high"
  return "routine"
}

function pctText(tokenEstimate: number, model: ModelLike | undefined): string {
  const limit = effectiveLimit(model)
  if (!limit) return `estimated visible context: ~${tokenEstimate} tokens`
  const pct = Math.min(999, Math.round((tokenEstimate / limit) * 100))
  const label = model?.limit?.input ? "effective input/context budget" : "context window"
  return `estimated visible context: ~${tokenEstimate}/${limit} tokens (${pct}% of the ${label})`
}

export function effectiveReminderInterval(configuredInterval: number, model: ModelLike | undefined): number {
  const limit = effectiveLimit(model)
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0 || limit >= configuredInterval) {
    return configuredInterval
  }
  return Math.max(1, Math.floor(limit * 0.8))
}

function usageRank(level: ReturnType<typeof usageLevel>): number {
  switch (level) {
    case "unknown":
      return 0
    case "routine":
      return 1
    case "high":
      return 2
    case "urgent":
      return 3
    case "critical":
      return 4
  }
}

function crossedUsageLevel(input: { tokenEstimate: number; lastEstimate: number; model?: ModelLike }): boolean {
  return usageRank(usageLevel(input.tokenEstimate, input.model)) > usageRank(usageLevel(input.lastEstimate, input.model))
}

function actionText(tokenEstimate: number, model: ModelLike | undefined): string {
  switch (usageLevel(tokenEstimate, model)) {
    case "critical":
      return "Critical: compact anything not immediately needed before more tool calls or long reasoning."
    case "urgent":
      return "Urgent: compact stale context now; do not postpone cleanup until overflow."
    case "high":
      return "High usage: clean up stale message ranges, starting with recent stale ranges."
    case "routine":
      return "Routine hygiene: compact any stale context not very likely to be useful soon, including tool output, resolved detours, and obsolete edits."
    case "unknown":
      return "Routine hygiene: compact any stale context not very likely to be useful soon, including tool output, resolved detours, and obsolete edits."
  }
}

export function reminderText(input: { tokenEstimate: number; model?: ModelLike }): string {
  return renderPrompt(loadPrompt("partial-compact-reminder.md"), {
    CONTEXT_STATUS: pctText(input.tokenEstimate, input.model),
    ACTION: actionText(input.tokenEstimate, input.model),
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
  const thresholdDue = crossedUsageLevel({ tokenEstimate, lastEstimate, ...(input.model ? { model: input.model } : {}) })
  if (tokenEstimate < interval && !thresholdDue) {
    debugLog(`partial_compact reminder skipped: session=${input.sessionID} visible_tokens≈${tokenEstimate} interval=${interval} level=${usageLevel(tokenEstimate, input.model)}`)
    return
  }
  const intervalDue = tokenEstimate - lastEstimate >= interval
  if (!intervalDue && !thresholdDue) {
    debugLog(`partial_compact reminder skipped: session=${input.sessionID} visible_tokens≈${tokenEstimate} last≈${lastEstimate} interval=${interval} level=${usageLevel(tokenEstimate, input.model)}`)
    return
  }
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
  debugLog(`partial_compact reminder injected: session=${input.sessionID} visible_tokens≈${tokenEstimate} interval=${interval} level=${usageLevel(tokenEstimate, input.model)}`)
}
