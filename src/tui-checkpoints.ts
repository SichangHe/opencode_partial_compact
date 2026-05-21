import type { Part } from "@opencode-ai/sdk/v2"
import type { CompactionRecord } from "./validate.js"

export type TuiMessage = {
  id: string
  role: string
  time?: { created?: number; completed?: number }
}

export type PartialCompactCheckpoint = {
  id: string
  messageID: string
  title: string
  description: string
}

export function firstCompactableMessageID(
  messages: readonly TuiMessage[],
  records: CompactionRecord[],
): string | null {
  if (messages.length === 0) return null
  let startIdx = 0
  for (const rec of records) {
    const fromIdx = messages.findIndex(msg => msg.id === rec.from_message_id)
    const toIdx = messages.findIndex(msg => msg.id === rec.to_message_id)
    if (fromIdx === -1 || toIdx === -1) continue
    startIdx = Math.max(startIdx, Math.max(fromIdx, toIdx) + 1)
  }
  return messages[startIdx]?.id ?? null
}

function messageTitle(msg: TuiMessage, parts: readonly Part[]): string {
  const text = parts.find(part => part.type === "text" && !part.synthetic)
  if (text?.type === "text") {
    const compact = text.text.replace(/\s+/g, " ").trim()
    if (compact.length > 0) return `${msg.role}: ${compact.slice(0, 72)}`
  }
  return `${msg.role} message ${msg.id}`
}

function describeMessage(msg: TuiMessage): string {
  const created = msg.time?.created
  const when = created ? new Date(created).toLocaleString() : "time unknown"
  return `Compact from the first eligible message through ${msg.id} (${when}).`
}

function partLabel(part: Part): string | null {
  switch (part.type) {
    case "tool":
      return `tool ${part.tool} ${part.state?.status ?? "unknown"}`
    case "patch":
      return `patch ${part.files.slice(0, 3).join(", ")}${part.files.length > 3 ? "..." : ""}`
    case "snapshot":
      return "snapshot"
    case "step-finish":
      return `step finished: ${part.reason}`
    case "compaction":
      return part.auto ? "auto compaction" : "manual compaction"
    default:
      return null
  }
}

export function buildPartialCompactCheckpoints(
  messages: readonly TuiMessage[],
  partsByMessage: ReadonlyMap<string, readonly Part[]>,
  records: CompactionRecord[],
): PartialCompactCheckpoint[] {
  const fromID = firstCompactableMessageID(messages, records)
  if (!fromID) return []
  const fromIdx = messages.findIndex(msg => msg.id === fromID)
  if (fromIdx === -1) return []

  const out: PartialCompactCheckpoint[] = []
  for (let i = fromIdx; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg) continue
    const parts = partsByMessage.get(msg.id) ?? []
    out.push({
      id: `message:${msg.id}`,
      messageID: msg.id,
      title: messageTitle(msg, parts),
      description: describeMessage(msg),
    })
    for (const part of parts) {
      const label = partLabel(part)
      if (!label) continue
      out.push({
        id: `part:${part.id}`,
        messageID: msg.id,
        title: `${label} @ ${msg.id}`,
        description: `Low-granularity checkpoint inside ${msg.id}; compacts from the first eligible message through its containing message.`,
      })
    }
  }
  return out.reverse()
}

export function buildPartialCompactPrompt(input: {
  fromMessageID: string
  toMessageID: string
  checkpointTitle: string
}): string {
  return `Manual partial compaction requested from the TUI.

Range:
- from_message_id: ${input.fromMessageID}
- to_message_id: ${input.toMessageID}
- selected checkpoint: ${input.checkpointTitle}

Write a concise replacement summary for exactly this contiguous range, then call partial_compact once with those exact message IDs and your summary. Preserve only facts needed later: decisions, file paths, tool outputs, errors, and assumptions. Do not ask follow-up questions. After the tool succeeds, report the result briefly.`
}
