import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import type { Part } from "@opencode-ai/sdk"
import { buildCompactTool, buildInstructionTool, type CompactToolClient } from "../src/tool"
import { loadState, _clearCache, _setStorageDir } from "../src/state"

const sid = "ses01TOOL00000000000000"

const messages: Array<{ info: { id: string; sessionID: string }; parts: Part[] }> = [
  { info: { id: "msg01A", sessionID: sid }, parts: [] },
  { info: { id: "msg01B", sessionID: sid }, parts: [] },
  { info: { id: "msg01C", sessionID: sid }, parts: [] },
  { info: { id: "msg01D", sessionID: sid }, parts: [] },
]

function client(): CompactToolClient {
  return {
    session: {
      messages: async () => ({ data: messages }),
    },
  }
}

function context(): ToolContext {
  return {
    sessionID: sid,
    messageID: "msg01CURRENT",
    agent: "build",
    directory: "/tmp/project",
    worktree: "/tmp/project",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: () => Effect.void,
  }
}

describe("partial_compact tool", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pc-tool-test-"))
    _setStorageDir(join(tempDir, "plugin", "opencode-partial-compact"))
    _clearCache()
  })

  afterEach(async () => {
    _setStorageDir(null)
    _clearCache()
    await rm(tempDir, { recursive: true, force: true })
  })

  it("preserves legacy single-range result shape", async () => {
    const compact = buildCompactTool(client(), {
      enabled: true,
      max_summary_chars: 2000,
      debug_log_path: null,
      reminder_enabled: true,
      reminder_interval_tokens: 16000,
    })

    const raw = await compact.execute({
      from_message_id: "msg01A",
      to_message_id: "msg01B",
      summary: "old setup no longer needed",
    }, context())
    const result = JSON.parse(typeof raw === "string" ? raw : raw.output) as { n_messages_replaced: number; truncated: boolean }

    expect(result.n_messages_replaced).toBe(2)
    expect(result.truncated).toBe(false)
    const state = await loadState(sid)
    expect(state.compactions).toHaveLength(1)
  })

  it("compacts multiple disjoint ranges in one call", async () => {
    const compact = buildCompactTool(client(), {
      enabled: true,
      max_summary_chars: 2000,
      debug_log_path: null,
      reminder_enabled: true,
      reminder_interval_tokens: 16000,
    })

    const raw = await compact.execute({
      ranges: [
        { from_message_id: "msg01A", to_message_id: "msg01A", summary: "first stale detour" },
        { from_message_id: "msg01C", to_message_id: "msg01D", summary: "second stale detour" },
      ],
    }, context())
    const result = JSON.parse(typeof raw === "string" ? raw : raw.output) as { n_ranges_compacted: number; n_messages_replaced: number }

    expect(result.n_ranges_compacted).toBe(2)
    expect(result.n_messages_replaced).toBe(3)
    const state = await loadState(sid)
    expect(state.compactions.map(rec => rec.from_message_id)).toEqual(["msg01A", "msg01C"])
  })

  it("compacts ranges across multiple sessions in one call", async () => {
    const otherSid = "ses01OTHER000000000000"
    const compact = buildCompactTool({
      session: {
        messages: async (input) => ({
          data: input.path.id === sid
            ? messages
            : [
                { info: { id: "msg02A", sessionID: otherSid }, parts: [] },
                { info: { id: "msg02B", sessionID: otherSid }, parts: [] },
              ],
        }),
      },
    }, {
      enabled: true,
      max_summary_chars: 2000,
      debug_log_path: null,
      reminder_enabled: true,
      reminder_interval_tokens: 16000,
    })

    const raw = await compact.execute({
      ranges: [
        { from_message_id: "msg01A", to_message_id: "msg01A", summary: "current session stale context" },
        { session_id: otherSid, from_message_id: "msg02A", to_message_id: "msg02B", summary: "other session stale context" },
      ],
    }, context())
    const result = JSON.parse(typeof raw === "string" ? raw : raw.output) as { n_ranges_compacted: number; ranges_compacted: Array<{ session_id: string }> }

    expect(result.n_ranges_compacted).toBe(2)
    expect(result.ranges_compacted.map(range => range.session_id)).toEqual([sid, otherSid])
    expect((await loadState(sid)).compactions).toHaveLength(1)
    expect((await loadState(otherSid)).compactions).toHaveLength(1)
  })

  it("rejects mixed legacy and batch modes without writing state", async () => {
    const compact = buildCompactTool(client(), {
      enabled: true,
      max_summary_chars: 2000,
      debug_log_path: null,
      reminder_enabled: true,
      reminder_interval_tokens: 16000,
    })

    const raw = await compact.execute({
      from_message_id: "msg01A",
      to_message_id: "msg01B",
      summary: "legacy",
      ranges: [{ from_message_id: "msg01C", to_message_id: "msg01D", summary: "batch" }],
    }, context())
    const result = JSON.parse(typeof raw === "string" ? raw : raw.output) as { error: string }

    expect(result.error).toContain("do not mix")
    expect((await loadState(sid)).compactions).toHaveLength(0)
  })

  it("treats materialized empty optional fields as absent", async () => {
    const compact = buildCompactTool(client(), {
      enabled: true,
      max_summary_chars: 2000,
      debug_log_path: null,
      reminder_enabled: true,
      reminder_interval_tokens: 16000,
    })

    const legacyRaw = await compact.execute({
      from_message_id: "msg01A",
      to_message_id: "msg01A",
      summary: "legacy summary",
      ranges: [],
    }, context())
    const legacyResult = JSON.parse(typeof legacyRaw === "string" ? legacyRaw : legacyRaw.output) as { n_messages_replaced: number }
    expect(legacyResult.n_messages_replaced).toBe(1)

    const otherSid = "ses01EMPTYOPT"
    const batchCompact = buildCompactTool({
      session: {
        messages: async (input) => ({
          data: input.path.id === sid
            ? messages
            : [{ info: { id: "msg03A", sessionID: otherSid }, parts: [] }],
        }),
      },
    }, {
      enabled: true,
      max_summary_chars: 2000,
      debug_log_path: null,
      reminder_enabled: true,
      reminder_interval_tokens: 16000,
    })
    const batchRaw = await batchCompact.execute({
      from_message_id: "",
      to_message_id: "",
      summary: "",
      ranges: [{ session_id: otherSid, from_message_id: "msg03A", to_message_id: "msg03A", summary: "batch summary" }],
    }, context())
    const batchResult = JSON.parse(typeof batchRaw === "string" ? batchRaw : batchRaw.output) as { n_ranges_compacted: number }
    expect(batchResult.n_ranges_compacted).toBe(1)

    const currentSessionBatchRaw = await batchCompact.execute({
      from_message_id: "",
      to_message_id: "",
      summary: "",
      ranges: [{ session_id: "", from_message_id: "msg01C", to_message_id: "msg01C", summary: "current batch summary" }],
    }, context())
    const currentSessionBatchResult = JSON.parse(typeof currentSessionBatchRaw === "string" ? currentSessionBatchRaw : currentSessionBatchRaw.output) as { ranges_compacted: Array<{ session_id: string }> }
    expect(currentSessionBatchResult.ranges_compacted[0].session_id).toBe(sid)
  })

  it("rejects batch ranges with empty summaries", async () => {
    const compact = buildCompactTool(client(), {
      enabled: true,
      max_summary_chars: 2000,
      debug_log_path: null,
      reminder_enabled: true,
      reminder_interval_tokens: 16000,
    })

    const raw = await compact.execute({
      from_message_id: "",
      to_message_id: "",
      summary: "",
      ranges: [{ from_message_id: "msg01A", to_message_id: "msg01A", summary: "" }],
    }, context())
    const result = JSON.parse(typeof raw === "string" ? raw : raw.output) as { error: string }

    expect(result.error).toContain("each range must include")
    expect((await loadState(sid)).compactions).toHaveLength(0)
  })

  it("returns the named instruction block", async () => {
    const instructionTool = buildInstructionTool()
    const raw = await instructionTool.execute({}, context())
    const output = typeof raw === "string" ? raw : raw.output

    expect(output).toContain("<instruction name=\"opencode-partial-compact\">")
    expect(output).toContain("ranges: [{ session_id?, from_message_id, to_message_id, summary }, ...]")
  })
})
