import { describe, expect, it } from "bun:test"
import { WrapperLedger } from "../src/ledger.js"
import { runDemo } from "../src/demo.js"
import { SelfCompactingCodexController } from "../src/self-compacting-controller.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { spawnSync } from "node:child_process"
import {
  CONTEXT_WINDOW_REMINDER_CONTEXT_KEY,
  ContextWindowReminderTracker,
  renderContextWindowReminder,
} from "../src/app-server-adapter.js"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
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

  it("compacts multiple disjoint ranges atomically", () => {
    const ledger = new WrapperLedger("test-session")
    const first = ledger.append("assistant", "stale one")
    const keep = ledger.append("tool", "keep")
    const second = ledger.append("assistant", "stale two")
    const result = ledger.partialCompactRanges([
      { from_message_id: first.id, to_message_id: first.id, summary: "first stale summary" },
      { from_message_id: second.id, to_message_id: second.id, summary: "second stale summary" },
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected compaction success")
    expect(result.n_ranges_compacted).toBe(2)
    expect(result.n_messages_replaced).toBe(2)
    expect(result.visible_message_ids).toEqual(["cmp000001", keep.id, "cmp000002"])
    const context = ledger.renderVisibleContext("system")
    expect(context).toContain("first stale summary")
    expect(context).toContain("second stale summary")
    expect(context).toContain("keep")
    expect(context).not.toContain("stale one")
    expect(context).not.toContain("stale two")
  })

  it("rejects overlapping requested ranges without partial writes", () => {
    const ledger = new WrapperLedger("test-session")
    const first = ledger.append("assistant", "one")
    const second = ledger.append("tool", "two")
    const third = ledger.append("assistant", "three")

    const result = ledger.partialCompactRanges([
      { from_message_id: first.id, to_message_id: second.id, summary: "first summary" },
      { from_message_id: second.id, to_message_id: third.id, summary: "overlap summary" },
    ])

    expect(result.ok).toBe(false)
    expect(ledger.compactions).toHaveLength(0)
    expect(ledger.currentVisibleMessageIds()).toEqual([first.id, second.id, third.id])
  })

  it("loads snapshots with validated ids and references", () => {
    const ledger = new WrapperLedger("test-session")
    const first = ledger.append("tool", "raw")
    ledger.partialCompact({
      from_message_id: first.id,
      to_message_id: first.id,
      summary: "summary",
    })

    const loaded = WrapperLedger.fromSnapshot(ledger.snapshot())
    expect(loaded.currentVisibleMessageIds()).toEqual(["cmp000001"])
    expect(loaded.append("assistant", "next").id).toBe("msg000002")

    const invalid = ledger.snapshot() as {
      compactions: Array<{ from_message_id: string }>
    }
    invalid.compactions[0] = { ...invalid.compactions[0], from_message_id: "msg999999" }
    expect(() => WrapperLedger.fromSnapshot(invalid)).toThrow("references missing from_message_id")
  })
})

describe("pcodx MCP sidecar", () => {
  it("keeps tool receipts compact and compacts multiple ranges in one call", async () => {
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-mcp-test-"))
    const ledger_path = join(run_dir, "ledger.json")
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", join(ROOT, "src", "mcp-server.ts")],
      env: {
        ...process.env,
        PCODX_LEDGER_PATH: ledger_path,
        PCODX_SESSION_ID: "pcodx-mcp-test",
      },
    })
    const client = new Client({ name: "pcodx-mcp-test", version: "0.1.0" })
    const raw_a = "PCODX_RAW_RECEIPT_SENTINEL_A"
    const raw_b = "PCODX_RAW_RECEIPT_SENTINEL_B"
    try {
      await client.connect(transport)
      const empty_ids = toolJson(await client.callTool({ name: "partial_compact_current_session_message_ids", arguments: {} }))
      const empty_visible_context_path = requireString(empty_ids.visible_context_path)
      const empty_visible_context = await readFile(empty_visible_context_path, "utf8")
      expect(empty_visible_context).toContain("<system>pcodx compacted visible context</system>")

      const first_raw = await client.callTool({
        name: "partial_compact_record_message",
        arguments: { role: "tool", text: raw_a, source: "test" },
      })
      const first_text = toolText(first_raw)
      expectReceiptHidesVisibleContext(first_text)
      expect(first_text).not.toContain(raw_a)
      const first = toolJson(first_raw)
      await client.callTool({
        name: "partial_compact_record_message",
        arguments: { role: "assistant", text: "durable keep", source: "test" },
      })
      const second_raw = await client.callTool({
        name: "partial_compact_record_message",
        arguments: { role: "tool", text: raw_b, source: "test" },
      })
      const second_text = toolText(second_raw)
      expectReceiptHidesVisibleContext(second_text)
      expect(second_text).not.toContain(raw_b)
      const second = toolJson(second_raw)
      const first_id = requireString(first.message_id)
      const second_id = requireString(second.message_id)

      const ids_text = toolText(await client.callTool({ name: "partial_compact_current_session_message_ids", arguments: {} }))
      expectReceiptHidesVisibleContext(ids_text)
      expect(ids_text).not.toContain(raw_a)
      expect(ids_text).not.toContain(raw_b)

      const compact_text = toolText(await client.callTool({
        name: "partial_compact",
        arguments: {
          ranges: [
            { from_message_id: first_id, to_message_id: first_id, summary: "first raw sentinel summary" },
            { from_message_id: second_id, to_message_id: second_id, summary: "second raw sentinel summary" },
          ],
        },
      }))
      expectReceiptHidesVisibleContext(compact_text)
      expect(compact_text).not.toContain(raw_a)
      expect(compact_text).not.toContain(raw_b)
      const compact = JSON.parse(compact_text) as { n_ranges_compacted: number; visible_context_path: string }
      expect(compact.n_ranges_compacted).toBe(2)
      const visible_context = await readFile(compact.visible_context_path, "utf8")
      expect(visible_context).toContain("first raw sentinel summary")
      expect(visible_context).toContain("second raw sentinel summary")
      expect(visible_context).toContain("durable keep")
      expect(visible_context).not.toContain(raw_a)
      expect(visible_context).not.toContain(raw_b)
    } finally {
      await client.close()
      await rm(run_dir, { recursive: true, force: true })
    }
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

describe("controller CLI", () => {
  it("persists selected compaction ranges for the next model-visible context", async () => {
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-controller-cli-test-"))
    const raw_a = "PCODX_CLI_RAW_SENTINEL_A ".repeat(400)
    const raw_b = "PCODX_CLI_RAW_SENTINEL_B ".repeat(400)
    try {
      const first = cliJson(run_dir, "record", "--role", "tool", "--text", raw_a)
      cliJson(run_dir, "record", "--role", "assistant", "--text", "durable middle")
      const second = cliJson(run_dir, "record", "--role", "tool", "--text", raw_b)
      const before = cliJson(run_dir, "show")
      const before_chars = requireNumber(before.visible_context_chars)
      const compact = cliJson(
        run_dir,
        "compact",
        "--range",
        `${requireString(first.message_id)}..${requireString(first.message_id)}`,
        "--summary",
        "first CLI raw sentinel summary",
        "--range",
        `${requireString(second.message_id)}..${requireString(second.message_id)}`,
        "--summary",
        "second CLI raw sentinel summary",
      )
      expect(compact.ok).toBe(true)
      expect(requireNumber(compact.after_visible_context_chars)).toBeLessThan(before_chars / 4)
      const visible_context_path = requireString(compact.model_visible_context_path)
      const visible_context = await readFile(visible_context_path, "utf8")
      expect(visible_context).toContain("first CLI raw sentinel summary")
      expect(visible_context).toContain("second CLI raw sentinel summary")
      expect(visible_context).toContain("durable middle")
      expect(visible_context).not.toContain("PCODX_CLI_RAW_SENTINEL_A")
      expect(visible_context).not.toContain("PCODX_CLI_RAW_SENTINEL_B")
    } finally {
      await rm(run_dir, { recursive: true, force: true })
    }
  })

  it("offers an interactive shell for recording and compacting context", async () => {
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-controller-cli-interactive-test-"))
    try {
      const output = cliText(run_dir, [
        "/record tool PCODX_INTERACTIVE_RAW_SENTINEL",
        "/ids",
        "/compact msg000001..msg000001 interactive raw sentinel summary",
        "/show",
        "/exit",
        "",
      ].join("\n"))
      expect(output).toContain("pcodx interactive Codex CLI")
      expect(output).toContain("recorded msg000001")
      expect(output).toContain("compacted 1 range")
      expect(output).toContain("----- context -----")
      expect(output).toContain("interactive raw sentinel summary")
      expect(output).not.toContain("PCODX_INTERACTIVE_RAW_SENTINEL")
      const visible_context = await readFile(join(run_dir, "model-visible-context.txt"), "utf8")
      expect(visible_context).toContain("interactive raw sentinel summary")
      expect(visible_context).not.toContain("PCODX_INTERACTIVE_RAW_SENTINEL")
    } finally {
      await rm(run_dir, { recursive: true, force: true })
    }
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

function toolText(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result)) {
    throw new Error("MCP tool result missing content")
  }
  const content = result.content
  if (!Array.isArray(content)) throw new Error("MCP tool result content is not an array")
  const text = content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string")
    .map(part => part.text)
    .join("\n")
  if (text.length === 0) throw new Error("MCP tool result has no text")
  return text
}

function toolJson(result: unknown): Record<string, unknown> {
  const parsed = JSON.parse(toolText(result))
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MCP tool result is not a JSON object")
  }
  return parsed as Record<string, unknown>
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected string")
  return value
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number") throw new Error("expected number")
  return value
}

function cliJson(run_dir: string, ...args: string[]): Record<string, unknown> {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", join(ROOT, "src", "controller-cli.ts"), "--run-dir", run_dir, "--session-id", "cli-test", ...args],
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!result.success) {
    throw new Error(`controller CLI failed: ${new TextDecoder().decode(result.stderr)}`)
  }
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout))
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("controller CLI did not return a JSON object")
  }
  return parsed as Record<string, unknown>
}

function cliText(run_dir: string, input: string): string {
  const result = spawnSync("bun", [
    "run",
    join(ROOT, "src", "controller-cli.ts"),
    "--run-dir",
    run_dir,
    "--session-id",
    "cli-interactive-test",
    "interactive",
  ], {
    input,
    encoding: "utf8",
    timeout: 30000,
  })
  if (result.status !== 0) throw new Error(`interactive controller CLI failed: ${result.stderr}`)
  return result.stdout
}

function expectReceiptHidesVisibleContext(text: string): void {
  expect(text).not.toContain("rendered_visible_context")
  expect(text).not.toContain("<system>")
  expect(text).not.toContain("<message")
  expect(text).not.toContain("<compacted")
}

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
