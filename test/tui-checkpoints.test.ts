import { describe, expect, it } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import {
  buildPartialCompactCheckpoints,
  buildPartialCompactPrompt,
  firstCompactableMessageID,
  type TuiMessage,
} from "../src/tui-checkpoints.js"

const messages: TuiMessage[] = [
  { id: "msg01", role: "user", time: { created: 1 } },
  { id: "msg02", role: "assistant", time: { created: 2 } },
  { id: "msg03", role: "user", time: { created: 3 } },
]

const systemMessage: TuiMessage = { id: "msg00", role: "system" }

function textPart(id: string, messageID: string, text: string): Part {
  return { id, sessionID: "ses", messageID, type: "text", text }
}

function patchPart(id: string, messageID: string): Part {
  return { id, sessionID: "ses", messageID, type: "patch", hash: "abc", files: ["src/a.ts", "src/b.ts"] }
}

describe("partial compact TUI checkpoints", () => {
  it("starts after active compaction records", () => {
    expect(firstCompactableMessageID(messages, [
      { from_message_id: "msg01", to_message_id: "msg02", summary: "old", created_at_iso: "" },
    ])).toBe("msg03")
  })

  it("builds message and part-level checkpoint options", () => {
    const parts = new Map<string, readonly Part[]>([
      ["msg01", [textPart("p1", "msg01", "please inspect the parser")]],
      ["msg02", [patchPart("p2", "msg02")]],
      ["msg03", [textPart("p3", "msg03", "continue")]],
    ])
    const checkpoints = buildPartialCompactCheckpoints(messages, parts, [])

    expect(checkpoints.map(checkpoint => checkpoint.id)).toContain("message:msg03")
    expect(checkpoints.map(checkpoint => checkpoint.id)).toContain("message:msg02")
    expect(checkpoints.map(checkpoint => checkpoint.id)).toContain("part:p2")
    expect(checkpoints.find(checkpoint => checkpoint.id === "part:p2")?.messageID).toBe("msg02")
  })

  it("accepts non-user and non-assistant message roles", () => {
    const checkpoints = buildPartialCompactCheckpoints([systemMessage], new Map(), [])
    expect(checkpoints[0]?.title).toBe("system message msg00")
  })

  it("builds an agent prompt that fixes the compaction range", () => {
    const prompt = buildPartialCompactPrompt({
      fromMessageID: "msg01",
      toMessageID: "msg03",
      checkpointTitle: "user: continue",
    })

    expect(prompt).toContain("from_message_id: msg01")
    expect(prompt).toContain("to_message_id: msg03")
    expect(prompt).toContain("call partial_compact once")
    expect(prompt).toContain("<instruction name=\"opencode-partial-compact\">")
    expect(prompt).toContain("use one batch call with ranges")
  })
})
