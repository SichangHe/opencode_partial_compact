import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { maybeInjectReminder, estimateVisibleTokens, reminderText, reminderTextWithMessageIDs } from "../src/reminder"
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

  it("injects one reminder after visible context grows by the fixed interval", async () => {
    const output = { system: [] as string[] }
    const tokenEstimate = estimateVisibleTokens(messages)
    await maybeInjectReminder({
      sessionID: sid,
      model: { limit: { context: 10000 } },
      output,
      messages,
      cfg: { reminder_enabled: true, reminder_interval_tokens: 100 },
    })

    expect(output.system).toEqual([reminderTextWithMessageIDs({ sessionID: sid, tokenEstimate, messages, model: { limit: { context: 10000 } } })])
    expect(output.system[0]).toContain("built-in auto-compaction is disabled")
    expect(output.system[0]).toContain("Do not compact just because this reminder appeared")
    expect(output.system[0]).toContain("If there is no safe stale range, continue the task")
    expect(output.system[0]).toContain("large diffs after commit")
    expect(output.system[0]).toContain("partial_compact_instructions")
    expect(output.system[0]).toContain("Current-session message IDs")
    expect(output.system[0]).toContain("msg01A, msg01B")
    expect(output.system[0]).not.toContain("<instruction name=\"opencode-partial-compact\">")
    expect(output.system[0]).toContain("% of the context window")
    const state = await loadState(sid)
    expect(state.last_reminder?.message_id).toBe("msg01B")
  })

  it("does not repeat before another interval of visible context growth", async () => {
    const cfg = { reminder_enabled: true, reminder_interval_tokens: 100 }
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
      cfg: { reminder_enabled: true, reminder_interval_tokens: rawTokens },
    })

    expect(output.system).toHaveLength(0)
  })

  it("omits message IDs hidden by existing compactions from reminders", async () => {
    await addCompaction(sid, {
      from_message_id: "msg01A",
      to_message_id: "msg01B",
      summary: "old setup and intermediate output were compacted",
      created_at_iso: "",
      n_messages_replaced: 2,
    })
    const withLaterMessage = [
      ...messages,
      {
        info: { id: "msg01C", sessionID: sid },
        parts: [{ id: "prt01C", sessionID: sid, messageID: "msg01C", type: "text" as const, text: "x".repeat(9000) }],
      },
    ]
    const output = { system: [] as string[] }

    await maybeInjectReminder({
      sessionID: sid,
      model: { limit: { context: 10000 } },
      output,
      messages: withLaterMessage,
      cfg: { reminder_enabled: true, reminder_interval_tokens: 100 },
    })

    expect(output.system).toHaveLength(1)
    expect(output.system[0]).toContain("msg01A, msg01C")
    expect(output.system[0]).not.toContain("msg01B")
  })

  it("waits until another fixed interval has accrued since the stored reminder estimate", async () => {
    const cfg = { reminder_enabled: true, reminder_interval_tokens: 100 }
    await maybeInjectReminder({ sessionID: sid, output: { system: [] }, messages, cfg })
    const bigger = [
      ...messages,
      {
        info: { id: "msg01C", sessionID: sid },
        parts: [{ id: "prt01C", sessionID: sid, messageID: "msg01C", type: "text" as const, text: "x".repeat(800) }],
      },
    ]
    const output = { system: [] as string[] }
    const tokenEstimate = estimateVisibleTokens(bigger)

    await maybeInjectReminder({ sessionID: sid, output, messages: bigger, cfg })

    expect(output.system).toEqual([reminderTextWithMessageIDs({ sessionID: sid, tokenEstimate, messages: bigger })])
  })

  it("rebaselines reminder cadence after visible context shrinks", async () => {
    const cfg = { reminder_enabled: true, reminder_interval_tokens: 100 }
    await maybeInjectReminder({ sessionID: sid, output: { system: [] }, messages, cfg })
    const highWater = (await loadState(sid)).last_reminder?.visible_token_estimate ?? 0
    await addCompaction(sid, {
      from_message_id: "msg01A",
      to_message_id: "msg01A",
      summary: "large output committed and no longer needed verbatim",
      created_at_iso: "",
      n_messages_replaced: 1,
    })

    const output = { system: [] as string[] }
    await maybeInjectReminder({ sessionID: sid, output, messages, cfg })
    const rebaselined = (await loadState(sid)).last_reminder?.visible_token_estimate ?? 0

    expect(output.system).toHaveLength(0)
    expect(rebaselined).toBeLessThan(highWater)
  })

  it("does not repeat a reminder in the same hook after a shrink rebaseline", async () => {
    const cfg = { reminder_enabled: true, reminder_interval_tokens: 100 }
    await maybeInjectReminder({ sessionID: sid, output: { system: [] }, messages, cfg })
    await addCompaction(sid, {
      from_message_id: "msg01A",
      to_message_id: "msg01A",
      summary: "large output committed and no longer needed verbatim",
      created_at_iso: "",
      n_messages_replaced: 1,
    })
    const output = { system: [] as string[] }

    await maybeInjectReminder({ sessionID: sid, output, messages, cfg })

    expect(output.system).toHaveLength(0)
  })

  it("clamps the effective interval for models smaller than the configured target", async () => {
    const output = { system: [] as string[] }
    const tokenEstimate = estimateVisibleTokens(messages)

    await maybeInjectReminder({
      sessionID: sid,
      model: { limit: { context: 2800 } },
      output,
      messages,
      cfg: { reminder_enabled: true, reminder_interval_tokens: 16000 },
    })

    expect(tokenEstimate).toBeGreaterThanOrEqual(2240)
    expect(output.system).toEqual([reminderTextWithMessageIDs({ sessionID: sid, tokenEstimate, messages, model: { limit: { context: 2800 } } })])
  })

  it("keeps the configured interval when the model context can support it", async () => {
    const output = { system: [] as string[] }

    await maybeInjectReminder({
      sessionID: sid,
      model: { limit: { context: 20000 } },
      output,
      messages,
      cfg: { reminder_enabled: true, reminder_interval_tokens: 16000 },
    })

    expect(output.system).toHaveLength(0)
  })

  it("falls back to a token-only estimate when the model context limit is unavailable", () => {
    const text = reminderText({ tokenEstimate: 1234 })

    expect(text).toContain("estimated visible context: ~1234 tokens")
    expect(text).toContain("after investigation, implementation, verification, review, commit, or push completes")
    expect(text).toContain("Do not compact just because this reminder appeared")
    expect(text).not.toContain("% of the context window")
  })
})
