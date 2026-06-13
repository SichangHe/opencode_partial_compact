import { readFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

function tool_text(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result)) {
    throw new Error("MCP tool result missing content")
  }
  const content = result.content
  if (!Array.isArray(content)) throw new Error("MCP tool result content is not an array")
  const text_parts = content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string")
    .map(part => part.text)
  if (text_parts.length === 0) throw new Error("MCP tool result has no text content")
  return text_parts.join("\n")
}

function parse_tool_json(result: unknown): Record<string, unknown> {
  const parsed = JSON.parse(tool_text(result))
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MCP tool result text is not a JSON object")
  }
  return parsed as Record<string, unknown>
}

const run_dir = await mkdtemp(join(tmpdir(), "pcodx-mcp-smoke-"))
const ledger_path = join(run_dir, "ledger.json")
const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", "src/mcp-server.ts"],
  env: {
    ...process.env,
    PCODX_LEDGER_PATH: ledger_path,
    PCODX_SESSION_ID: "pcodx-smoke",
  },
})
const client = new Client({ name: "pcodx-mcp-smoke", version: "0.1.0" })

try {
  await client.connect(transport)
  const tools = await client.listTools()
  const names = tools.tools.map(tool => tool.name).sort()
  for (const expected of ["partial_compact", "partial_compact_current_session_message_ids", "partial_compact_instructions", "partial_compact_record_message"]) {
    if (!names.includes(expected)) throw new Error(`missing MCP tool: ${expected}`)
  }
  const instructions = await client.callTool({ name: "partial_compact_instructions", arguments: {} })
  const instructions_text = tool_text(instructions)
  for (const expected of ["expected context hygiene", "Expected triggers", "roughly 10 substantive tool or command results", "Context-window reminder", "stock CLI worker's next model call is not smaller by itself"]) {
    if (!instructions_text.includes(expected)) throw new Error(`missing instruction text: ${expected}`)
  }
  const first_record = await client.callTool({
    name: "partial_compact_record_message",
    arguments: { role: "user", text: "stale observation A", source: "smoke" },
  })
  if (parse_tool_json(first_record).native_context_rewritten !== false) {
    throw new Error("record result did not disclose native context boundary")
  }
  await client.callTool({
    name: "partial_compact_record_message",
    arguments: { role: "assistant", text: "stale observation B", source: "smoke" },
  })
  const before_ids = await client.callTool({
    name: "partial_compact_current_session_message_ids",
    arguments: {},
  })
  const before = parse_tool_json(before_ids)
  const before_visible_ids = before.visible_message_ids
  if (!Array.isArray(before_visible_ids) || before_visible_ids.join(",") !== "msg000001,msg000002") {
    throw new Error(`unexpected pre-compaction visible ids: ${JSON.stringify(before_visible_ids)}`)
  }
  const before_context = before.rendered_visible_context
  if (typeof before_context !== "string") throw new Error("pre-compaction context missing rendered text")
  for (const expected of ["stale observation A", "stale observation B"]) {
    if (!before_context.includes(expected)) throw new Error(`missing pre-compaction visible context: ${expected}`)
  }
  const compact = await client.callTool({
    name: "partial_compact",
    arguments: {
      from_message_id: "msg000001",
      to_message_id: "msg000002",
      summary: "smoke summary replacing two stale observations",
    },
  })
  const ledger = readFileSync(ledger_path, "utf-8")
  if (!ledger.includes("cmp000001")) throw new Error("ledger did not record compaction")
  const compact_result = parse_tool_json(compact)
  if (compact_result.ok !== true) throw new Error(`compaction failed: ${JSON.stringify(compact_result)}`)
  const compact_visible_ids = compact_result.visible_message_ids
  if (!Array.isArray(compact_visible_ids) || compact_visible_ids.join(",") !== "cmp000001") {
    throw new Error(`unexpected compaction visible ids: ${JSON.stringify(compact_visible_ids)}`)
  }
  if (compact_result.native_context_rewritten !== false) throw new Error("MCP result did not disclose native context boundary")
  const compact_context = compact_result.rendered_visible_context
  if (typeof compact_context !== "string") throw new Error("compaction result missing rendered context")
  if (!compact_context.includes("smoke summary replacing two stale observations")) {
    throw new Error("tool result did not include compaction summary")
  }
  if (compact_context.includes("stale observation A") || compact_context.includes("stale observation B")) {
    throw new Error("tool result still exposed compacted raw observations")
  }
  const after_ids = await client.callTool({
    name: "partial_compact_current_session_message_ids",
    arguments: {},
  })
  const after = parse_tool_json(after_ids)
  const after_visible_ids = after.visible_message_ids
  if (!Array.isArray(after_visible_ids) || after_visible_ids.join(",") !== "cmp000001") {
    throw new Error(`unexpected post-compaction visible ids: ${JSON.stringify(after_visible_ids)}`)
  }
  const after_context = after.rendered_visible_context
  if (typeof after_context !== "string") throw new Error("post-compaction context missing rendered text")
  if (!after_context.includes("smoke summary replacing two stale observations")) {
    throw new Error("post-compaction context did not include compaction summary")
  }
  if (after_context.includes("stale observation A") || after_context.includes("stale observation B")) {
    throw new Error("post-compaction context still exposed compacted raw observations")
  }
  console.log(JSON.stringify({ ok: true, run_dir, ledger_path, tools: names }, null, 2))
} finally {
  await client.close()
}
