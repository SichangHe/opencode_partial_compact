import { loadPrompt, renderPrompt } from "./prompt-loader.js"

export type MessageIDLike = {
  info: { id: string; sessionID: string }
}

const MAX_MESSAGE_IDS = 96
const HEAD_MESSAGE_IDS = 16

function messageIDLines(messages: readonly MessageIDLike[]): string {
  if (messages.length === 0) return "- No current-session message IDs are available yet."
  const visible = messages.length <= MAX_MESSAGE_IDS
    ? messages
    : [
      ...messages.slice(0, HEAD_MESSAGE_IDS),
      ...messages.slice(messages.length - (MAX_MESSAGE_IDS - HEAD_MESSAGE_IDS)),
    ]
  const lines: string[] = []
  for (let i = 0; i < visible.length; i += 8) {
    if (messages.length > MAX_MESSAGE_IDS && i === HEAD_MESSAGE_IDS) {
      lines.push(`- ... ${messages.length - MAX_MESSAGE_IDS} older middle IDs omitted; use session history tools if you need them ...`)
    }
    lines.push(`- ${visible.slice(i, i + 8).map(msg => msg.info.id).join(", ")}`)
  }
  return lines.join("\n")
}

export function currentSessionMessageIDReference(
  sessionID: string,
  messages: readonly MessageIDLike[],
): string {
  return renderPrompt(loadPrompt("current-session-message-ids.md"), {
    SESSION_ID: sessionID,
    MESSAGE_ID_LINES: messageIDLines(messages),
  })
}
