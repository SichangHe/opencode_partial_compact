import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { maybeInjectReminder, estimateVisibleTokens, reminderText } from "../src/reminder"
import { addCompaction, loadState, _clearCache, _setStorageDir } from "../src/state"

const sid = "ses01REMINDER000000000"

const messages = [
  {
    info: { id: "msg01A", sessionID: sid },
    parts: [{ id: "prt01A", sessionID: sid, messageID: "msg01A", type: "text" as const, text: "x".repeat(9000) }],
  },
  {
    info: { id: "msg01B", sessionID: sid },
    parts: [{ id: "prt01B", sessionID: sid, messageID: "msg01B", type: "text" as const, text: "keep" }],
  },
]

describe("partial compact reminders", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pc-reminder-test-"))
    _setStorageDir(join(tempDir, "plugin", "opencode-partial-compact"))
    _clearCache()
  })

  afterEach(async () => {
    _setStorageDir(null)
    _clearCache()
    await rm(tempDir, { recursive: true, force: true })
  })

  it("injects a single reminder after visible context grows by the configured fraction", async () => {
    const output = { system: [] as string[] }
    await maybeInjectReminder({
      sessionID: sid,
      model: { limit: { context: 10000 } },
      output,
      messages,
      cfg: { reminder_enabled: true, reminder_context_fraction: 0.1, reminder_min_tokens: 100 },
    })

    expect(output.system).toEqual([reminderText()])
    const state = await loadState(sid)
    expect(state.last_reminder?.message_id).toBe("msg01B")
  })

  it("does not repeat before another interval of visible context growth", async () => {
    const cfg = { reminder_enabled: true, reminder_context_fraction: 0.1, reminder_min_tokens: 100 }
    await maybeInjectReminder({ sessionID: sid, model: { limit: { context: 10000 } }, output: { system: [] }, messages, cfg })
    const output = { system: [] as string[] }
    await maybeInjectReminder({ sessionID: sid, model: { limit: { context: 10000 } }, output, messages, cfg })

    expect(output.system).toHaveLength(0)
  })

  it("bases cadence on the compacted visible view", async () => {
    await addCompaction(sid, {
      from_message_id: "msg01A",
      to_message_id: "msg01A",
      summary: "large output was irrelevant",
      created_at_iso: "",
      n_messages_replaced: 1,
    })
    const rawTokens = estimateVisibleTokens(messages)
    const output = { system: [] as string[] }
    await maybeInjectReminder({
      sessionID: sid,
      model: { limit: { context: 10000 } },
      output,
      messages,
      cfg: { reminder_enabled: true, reminder_context_fraction: 0.1, reminder_min_tokens: rawTokens },
    })

    expect(output.system).toHaveLength(0)
  })
})
