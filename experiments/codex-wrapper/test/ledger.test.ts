import { describe, expect, it } from "bun:test"
import { WrapperLedger } from "../src/ledger.js"
import { runDemo } from "../src/demo.js"
import { SelfCompactingCodexController } from "../src/self-compacting-controller.js"
import {
  CONTEXT_WINDOW_REMINDER_CONTEXT_KEY,
  ContextWindowReminderTracker,
  renderContextWindowReminder,
} from "../src/app-server-adapter.js"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

describe("WrapperLedger", () => {
  it("injects message ids and replaces compacted ranges with summaries", () => {
    const ledger = new WrapperLedger("test-session")
    ledger.append("user", "task")
    const first = ledger.append("assistant", "old exploration")
    const second = ledger.append("tool", "raw stale output")
    ledger.append("assistant", "new useful work")

    const result = ledger.partialCompact({
      from_message_id: first.id,
      to_message_id: second.id,
      summary: "old exploration summary",
    })

    expect(result.ok).toBe(true)
    const context = ledger.renderVisibleContext("system")
    expect(context).toContain(`<message id="msg000001" role="user">`)
    expect(context).toContain(`<compacted id="cmp000001" range="${first.id}..${second.id}">`)
    expect(context).toContain("old exploration summary")
    expect(context).not.toContain("raw stale output")
  })

  it("rejects overlapping ranges", () => {
    const ledger = new WrapperLedger("test-session")
    const first = ledger.append("user", "one")
    const second = ledger.append("assistant", "two")
    const third = ledger.append("tool", "three")
    expect(ledger.partialCompact({
      from_message_id: first.id,
      to_message_id: second.id,
      summary: "summary",
    }).ok).toBe(true)

    const result = ledger.partialCompact({
      from_message_id: second.id,
      to_message_id: third.id,
      summary: "overlap",
    })
    expect(result.ok).toBe(false)
  })
})

describe("demo", () => {
  it("continues after partial compaction and writes receipts", async () => {
    await runDemo()
    const before = await readFile(join(ROOT, "runs", "latest", "visible-before-compaction.txt"), "utf8")
    const after = await readFile(join(ROOT, "runs", "latest", "visible-after-compaction.txt"), "utf8")
    const finalReport = await readFile(join(ROOT, "runs", "latest", "final-report.md"), "utf8")

    expect(before).toContain("STALE_LEGACY_AUDIT_BLOCK")
    expect(after).toContain("<compacted")
    expect(after).toContain("codex app-server curated-context injection probe: ok")
    expect(after).not.toContain("STALE_LEGACY_AUDIT_BLOCK")
    expect(finalReport).toContain("production config sets `requestTimeoutMs` to 12000")
    expect(finalReport).toContain("Recommended fix")
  })
})

describe("SelfCompactingCodexController", () => {
  it("renders future app-server history from compacted ledger state", () => {
    const controller = new SelfCompactingCodexController({ session_id: "controller-test" })
    const first = controller.append("tool", "PCODX_RAW_CONTROLLER_SENTINEL_A", "tool:test")
    const last = controller.append("tool", "PCODX_RAW_CONTROLLER_SENTINEL_B", "tool:test")
    const result = controller.partialCompact({
      from_message_id: first.id,
      to_message_id: last.id,
      summary: "controller summary survives",
    })

    expect(result.ok).toBe(true)
    const history = JSON.stringify(controller.historyItems())
    expect(history).toContain("controller summary survives")
    expect(history).not.toContain("PCODX_RAW_CONTROLLER_SENTINEL_A")
    expect(history).not.toContain("PCODX_RAW_CONTROLLER_SENTINEL_B")
    expect(controller.currentVisibleMessageIds()).toEqual(["cmp000001"])
    expect(controller.compactableMessageIds()).toEqual([])
  })
})

describe("context window reminders", () => {
  it("renders app-server token usage as turn additional context", () => {
    const tracker = new ContextWindowReminderTracker()
    const event = observeTokenUsage(tracker, 81000)

    expect(event?.usage.last.inputTokens).toBe(81000)
    const additional_context = tracker.additionalContext("thread-1")
    const reminder = additional_context?.[CONTEXT_WINDOW_REMINDER_CONTEXT_KEY]
    expect(reminder?.kind).toBe("application")
    expect(reminder?.value).toContain("81%")
    expect(reminder?.value).toContain("record durable state now")
  })

  it("gates app-server reminders by token-growth cadence", () => {
    const tracker = new ContextWindowReminderTracker()
    observeTokenUsage(tracker, 15999)
    expect(tracker.additionalContext("thread-1")).toBeUndefined()

    observeTokenUsage(tracker, 16000)
    const first_reminder = tracker.additionalContext("thread-1")?.[CONTEXT_WINDOW_REMINDER_CONTEXT_KEY]
    expect(first_reminder?.value).toContain("16%")
    expect(tracker.additionalContext("thread-1")).toBeUndefined()

    observeTokenUsage(tracker, 31999)
    expect(tracker.additionalContext("thread-1")).toBeUndefined()

    observeTokenUsage(tracker, 32000)
    const second_reminder = tracker.additionalContext("thread-1")?.[CONTEXT_WINDOW_REMINDER_CONTEXT_KEY]
    expect(second_reminder?.value).toContain("32%")
  })

  it("resets app-server reminder cadence after context shrink", () => {
    const tracker = new ContextWindowReminderTracker()
    observeTokenUsage(tracker, 40000)
    expect(tracker.additionalContext("thread-1")).toBeDefined()

    observeTokenUsage(tracker, 10000)
    expect(tracker.additionalContext("thread-1")).toBeUndefined()

    observeTokenUsage(tracker, 25999)
    expect(tracker.additionalContext("thread-1")).toBeUndefined()

    observeTokenUsage(tracker, 26000)
    expect(tracker.additionalContext("thread-1")).toBeDefined()
  })

  it("ignores malformed token usage notifications", () => {
    const tracker = new ContextWindowReminderTracker()
    expect(tracker.observe("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: { last: {}, total: {}, modelContextWindow: 100000 },
    })).toBeNull()
    expect(tracker.additionalContext("thread-1")).toBeUndefined()
  })

  it("renders reminders when app-server omits the model context window", () => {
    expect(renderContextWindowReminder({
      total: {
        totalTokens: 10,
        inputTokens: 8,
        cachedInputTokens: 0,
        outputTokens: 2,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 10,
        inputTokens: 8,
        cachedInputTokens: 0,
        outputTokens: 2,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: null,
    })).toContain("model context window was not reported")
  })
})

function observeTokenUsage(
  tracker: ContextWindowReminderTracker,
  input_tokens: number,
  model_context_window: number | null = 100000,
) {
  return tracker.observe("thread/tokenUsage/updated", {
    threadId: "thread-1",
    turnId: `turn-${input_tokens}`,
    tokenUsage: {
      total: {
        totalTokens: input_tokens + 100,
        inputTokens: input_tokens,
        cachedInputTokens: 0,
        outputTokens: 100,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: input_tokens + 100,
        inputTokens: input_tokens,
        cachedInputTokens: 0,
        outputTokens: 100,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: model_context_window,
    },
  })
}
