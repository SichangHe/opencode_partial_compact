import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import type { Part } from "@opencode-ai/sdk"
import { server } from "../src/plugin"
import { buildCompactTool, buildInstructionTool, buildInstructionToolWithClient, type CompactToolClient } from "../src/tool"
import { loadState, _clearCache, _setStorageDir } from "../src/state"
import { estimateVisibleTokens, maybeInjectReminder } from "../src/reminder"
import { applyCompactions } from "../src/hook"

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

function clientWith(data: Array<{ info: { id: string; sessionID: string }; parts: Part[] }>): CompactToolClient {
  return {
    session: {
      messages: async () => ({ data }),
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
    ask: async () => {},
  }
}

const pluginClient = {
  ...client(),
  config: {
    get: async () => ({ data: { compaction: { auto: false }, plugin: ["opencode-partial-compact"] } }),
  },
}

function pluginInput(directory: string): PluginInput {
  return {
    client: pluginClient as unknown as PluginInput["client"],
    project: {} as unknown as PluginInput["project"],
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://127.0.0.1"),
    $: (() => {}) as unknown as PluginInput["$"],
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

  it("returns current-session message IDs with the instruction block when client-backed", async () => {
    const instructionTool = buildInstructionToolWithClient(client())
    const raw = await instructionTool.execute({}, context())
    const output = typeof raw === "string" ? raw : raw.output

    expect(output).toContain("<instruction name=\"opencode-partial-compact\">")
    expect(output).toContain("Current-session message IDs for `partial_compact`")
    expect(output).toContain(`session_id: ${sid}`)
    expect(output).toContain("msg01A, msg01B, msg01C, msg01D")
  })

  it("returns instructions when current-session message IDs cannot be loaded", async () => {
    const failingClient: CompactToolClient = {
      session: {
        messages: async () => { throw new Error("session unavailable") },
      },
    }
    const instructionTool = buildInstructionToolWithClient(failingClient)
    const raw = await instructionTool.execute({}, context())
    const output = typeof raw === "string" ? raw : raw.output

    expect(output).toContain("<instruction name=\"opencode-partial-compact\">")
    expect(output).toContain("No current-session message IDs are available yet")
  })

  it("caps current-session message ID snapshots", async () => {
    const manyMessages = Array.from({ length: 130 }, (_, idx) => ({
      info: { id: `msg${String(idx).padStart(3, "0")}`, sessionID: sid },
      parts: [] as Part[],
    }))
    const instructionTool = buildInstructionToolWithClient(clientWith(manyMessages))
    const raw = await instructionTool.execute({}, context())
    const output = typeof raw === "string" ? raw : raw.output

    expect(output).toContain("34 older middle IDs omitted")
    expect(output).toContain("msg000")
    expect(output).toContain("msg129")
    expect(output).not.toContain("msg030")
  })

  it("registers the client-backed instruction tool from the plugin server", async () => {
    const projectDir = join(tempDir, "project")
    const configDir = join(projectDir, ".opencode")
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, "opencode-partial-compact.jsonc"), '{ "debug_log_path": null }')
    const hooks = await server(pluginInput(projectDir))
    if (!hooks.tool) throw new Error("expected plugin server to register tools")
    const raw = await hooks.tool.partial_compact_instructions.execute({}, context())
    const output = typeof raw === "string" ? raw : raw.output

    expect(output).toContain("Current-session message IDs for `partial_compact`")
    expect(output).toContain("msg01A, msg01B, msg01C, msg01D")
  })

  it("omits message IDs hidden by existing current-session compactions", async () => {
    await loadState(sid)
    const compact = buildCompactTool(client(), {
      enabled: true,
      max_summary_chars: 2000,
      debug_log_path: null,
      reminder_enabled: true,
      reminder_interval_tokens: 16000,
    })
    await compact.execute({
      from_message_id: "msg01A",
      to_message_id: "msg01B",
      summary: "old range already compacted",
    }, context())

    const instructionTool = buildInstructionToolWithClient(client())
    const raw = await instructionTool.execute({}, context())
    const output = typeof raw === "string" ? raw : raw.output

    expect(output).toContain("msg01A, msg01C, msg01D")
    expect(output).not.toContain("msg01B")
  })

  it("rebaselines reminder cadence immediately after a successful compaction", async () => {
    const compact = buildCompactTool(client(), {
      enabled: true,
      max_summary_chars: 2000,
      debug_log_path: null,
      reminder_enabled: true,
      reminder_interval_tokens: 16000,
    })

    await compact.execute({
      from_message_id: "msg01A",
      to_message_id: "msg01B",
      summary: "old setup and command output are now durable elsewhere",
    }, context())

    const state = await loadState(sid)
    const visible = messages.map(msg => ({ info: msg.info, parts: [...msg.parts] }))
    applyCompactions(visible, state.compactions)

    expect(state.last_reminder?.message_id).toBe("msg01D")
    expect(state.last_reminder?.visible_token_estimate).toBe(estimateVisibleTokens(visible))
  })

  it("does not inject another reminder on the next turn after tool compaction", async () => {
    const bulkyMessages: Array<{ info: { id: string; sessionID: string }; parts: Part[] }> = [
      {
        info: { id: "msg01A", sessionID: sid },
        parts: [{ id: "prt01A", sessionID: sid, messageID: "msg01A", type: "text", text: "x".repeat(9000) }],
      },
      {
        info: { id: "msg01B", sessionID: sid },
        parts: [{ id: "prt01B", sessionID: sid, messageID: "msg01B", type: "text", text: "keep" }],
      },
    ]
    const cfg = {
      enabled: true,
      max_summary_chars: 2000,
      debug_log_path: null,
      reminder_enabled: true,
      reminder_interval_tokens: 100,
    }
    await maybeInjectReminder({ sessionID: sid, output: { system: [] }, messages: bulkyMessages, cfg })
    const compact = buildCompactTool(clientWith(bulkyMessages), cfg)
    await compact.execute({
      from_message_id: "msg01A",
      to_message_id: "msg01A",
      summary: "bulky raw output was summarized after its conclusion became durable",
    }, context())
    const output = { system: [] as string[] }

    await maybeInjectReminder({ sessionID: sid, output, messages: bulkyMessages, cfg })

    expect(output.system).toHaveLength(0)
  })
})
