import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { maybeInjectReminder, estimateVisibleTokens, reminderText, reminderTextWithMessageIDs, effectiveReminderInterval } from "../src/reminder"
import { addCompaction, loadState, recordReminder, _clearCache, _setStorageDir } from "../src/state"

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
    expect(output.system[0]).toMatch(/^current context window: [0-9.]+k \(\d+% full\)$/)
    expect(output.system[0]).not.toContain("Current-session message IDs")
    expect(output.system[0]).not.toContain("<instruction name=\"opencode-partial-compact\">")
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
    expect(output.system[0]).toMatch(/^current context window: [0-9.]+k \(\d+% full\)$/)
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


  it("uses the configured 400k input budget for a synthetic historic-threshold session", async () => {
    const highSession = "ses01HISTORICTHRESHOLD"
    const highMessages = [
      {
        info: { id: "msg01H", sessionID: highSession },
        parts: [{ id: "prt01H", sessionID: highSession, messageID: "msg01H", type: "text" as const, text: "x".repeat(1_040_000) }],
      },
      {
        info: { id: "msg01I", sessionID: highSession },
        parts: [{ id: "prt01I", sessionID: highSession, messageID: "msg01I", type: "text" as const, text: "current work" }],
      },
    ]
    const tokenEstimate = estimateVisibleTokens(highMessages)
    const output = { system: [] as string[] }

    await maybeInjectReminder({
      sessionID: highSession,
      model: { limit: { context: 400000, input: 400000, output: 128000 } },
      output,
      messages: highMessages,
      cfg: { reminder_enabled: true, reminder_interval_tokens: 16000 },
    })

    expect(tokenEstimate).toBeGreaterThan(260000)
    expect(tokenEstimate).toBeLessThan(280000)
    expect(output.system[0]).toContain("current context window:")
    expect(output.system[0]).toContain("% full")
  })

  it("reports usage against the explicit input budget when present", async () => {
    const output = { system: [] as string[] }

    await maybeInjectReminder({
      sessionID: sid,
      model: { limit: { context: 400000, input: 10000 } },
      output,
      messages,
      cfg: { reminder_enabled: true, reminder_interval_tokens: 100 },
    })

    expect(output.system[0]).toContain("current context window:")
    expect(output.system[0]).toContain("% full")
    expect(output.system[0]).not.toContain("effective input/context budget")
  })

  it("reports compact context-window usage above 50, 80, and 90 percent", () => {
    expect(reminderText({ tokenEstimate: 6000, model: { limit: { input: 10000, context: 400000 } } }))
      .toBe("current context window: 6k (60% full)")
    expect(reminderText({ tokenEstimate: 8500, model: { limit: { input: 10000, context: 400000 } } }))
      .toBe("current context window: 8.5k (85% full)")
    expect(reminderText({ tokenEstimate: 9500, model: { limit: { input: 10000, context: 400000 } } }))
      .toBe("current context window: 9.5k (95% full)")
  })


  it("emits when crossing the 50 percent threshold before the cadence interval", async () => {
    const thresholdSession = "ses01HALFTHRESHOLD"
    const thresholdMessages = [{
      info: { id: "msg01H", sessionID: thresholdSession },
      parts: [{ id: "prt01H", sessionID: thresholdSession, messageID: "msg01H", type: "text" as const, text: "x".repeat(20_000) }],
    }]
    await recordReminder(thresholdSession, {
      visible_token_estimate: 4900,
      message_id: "msg01H",
      created_at_iso: new Date().toISOString(),
    })
    const output = { system: [] as string[] }

    await maybeInjectReminder({
      sessionID: thresholdSession,
      model: { limit: { input: 10000, context: 400000 } },
      output,
      messages: thresholdMessages,
      cfg: { reminder_enabled: true, reminder_interval_tokens: 16000 },
    })

    expect(estimateVisibleTokens(thresholdMessages)).toBeLessThan(8000)
    expect(output.system[0]).toContain("current context window:")
  })

  it("emits again when crossing a higher usage threshold before another full interval", async () => {
    const thresholdSession = "ses01THRESHOLD"
    const thresholdMessages = [{
      info: { id: "msg01T", sessionID: thresholdSession },
      parts: [{ id: "prt01T", sessionID: thresholdSession, messageID: "msg01T", type: "text" as const, text: "x".repeat(33_000) }],
    }]
    await recordReminder(thresholdSession, {
      visible_token_estimate: 6000,
      message_id: "msg01T",
      created_at_iso: new Date().toISOString(),
    })
    const output = { system: [] as string[] }

    await maybeInjectReminder({
      sessionID: thresholdSession,
      model: { limit: { input: 10000, context: 400000 } },
      output,
      messages: thresholdMessages,
      cfg: { reminder_enabled: true, reminder_interval_tokens: 16000 },
    })

    expect(effectiveReminderInterval(16000, { limit: { input: 10000, context: 400000 } })).toBe(8000)
    expect(estimateVisibleTokens(thresholdMessages)).toBeLessThan(14000)
    expect(output.system[0]).toContain("current context window:")
  })

  it("falls back to a token-only estimate when the model context limit is unavailable", () => {
    const text = reminderText({ tokenEstimate: 1234 })

    expect(text).toBe("current context window: 1.2k (unknown% full)")
  })
})
