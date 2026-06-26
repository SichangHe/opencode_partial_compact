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
  if (names.includes("partial_compact")) throw new Error("broken MCP tool is still advertised: partial_compact")
  for (const expected of ["partial_compact_current_ids", "partial_compact_current_session_message_ids", "partial_compact_instructions", "partial_compact_record_message"]) {
    if (!names.includes(expected)) throw new Error(`missing MCP tool: ${expected}`)
  }
  await assert_call_rejected(client, "partial_compact")
  const instructions = await client.callTool({ name: "partial_compact_instructions", arguments: {} })
  const instructions_text = tool_text(instructions)
  for (const expected of ["expected context hygiene", "Expected triggers", "roughly 10 substantive tool or command results", "Context-window reminder", "stock CLI worker's next model call is not smaller by itself", "partial_compact_record_message"]) {
    if (!instructions_text.includes(expected)) throw new Error(`missing instruction text: ${expected}`)
  }
  if (instructions_text.includes("then call partial_compact")) {
    throw new Error("startup instructions still tell workers to call partial_compact")
  }
  const first_record = await client.callTool({
    name: "partial_compact_record_message",
    arguments: { role: "user", text: "stale observation A", source: "smoke" },
  })
  const first_record_text = tool_text(first_record)
  assert_receipt_hides_visible_context(first_record_text)
  if (first_record_text.includes("stale observation A")) {
    throw new Error("record result exposed raw recorded text")
  }
  if (parse_tool_json(first_record).native_context_rewritten !== false) {
    throw new Error("record result did not disclose native context boundary")
  }
  await client.callTool({
    name: "partial_compact_record_message",
    arguments: { role: "assistant", text: "stale observation B", source: "smoke" },
  })
  const before_ids = await client.callTool({
    name: "partial_compact_current_ids",
    arguments: {},
  })
  const before = parse_tool_json(before_ids)
  const before_visible_ids = before.visible_message_ids
  if (!Array.isArray(before_visible_ids) || before_visible_ids.join(",") !== "msg1,msg2") {
    throw new Error(`unexpected pre-compaction visible ids: ${JSON.stringify(before_visible_ids)}`)
  }
  const before_text = tool_text(before_ids)
  assert_receipt_hides_visible_context(before_text)
  if (before_text.includes("stale observation A") || before_text.includes("stale observation B")) {
    throw new Error("pre-compaction id result exposed raw recorded text")
  }
  const ledger = readFileSync(ledger_path, "utf-8")
  if (ledger.includes("cmp1")) throw new Error("ledger unexpectedly recorded compaction")
  const after_ids = await client.callTool({
    name: "partial_compact_current_ids",
    arguments: {},
  })
  const after = parse_tool_json(after_ids)
  const after_visible_ids = after.visible_message_ids
  if (!Array.isArray(after_visible_ids) || after_visible_ids.join(",") !== "msg1,msg2") {
    throw new Error(`unexpected post-record visible ids: ${JSON.stringify(after_visible_ids)}`)
  }
  const after_text = tool_text(after_ids)
  assert_receipt_hides_visible_context(after_text)
  if (after_text.includes("stale observation A") || after_text.includes("stale observation B")) {
    throw new Error("post-record id result exposed raw observations")
  }
  const visible_context_path = parse_tool_json(after_ids).visible_context_path
  if (typeof visible_context_path !== "string") throw new Error("id result missing visible_context_path")
  const artifact_context = readFileSync(visible_context_path, "utf-8")
  if (!artifact_context.includes("stale observation A") || !artifact_context.includes("stale observation B")) {
    throw new Error("visible context artifact did not preserve recorded observations")
  }
  console.log(JSON.stringify({ ok: true, run_dir, ledger_path, tools: names }, null, 2))
} finally {
  await client.close()
}

function assert_receipt_hides_visible_context(text: string): void {
  for (const hidden of ["rendered_visible_context", "<system>", "<message", "<compacted", "<aboveturn", "<pcodx-message", "<pcodx-compacted"]) {
    if (text.includes(hidden)) throw new Error(`tool receipt exposed visible context marker ${hidden}`)
  }
}

async function assert_call_rejected(client: Client, name: string): Promise<void> {
  try {
    const result = await client.callTool({ name, arguments: {} })
    if (typeof result === "object" && result !== null && "isError" in result && result.isError === true) return
  } catch {
    return
  }
  throw new Error(`removed MCP tool remained callable: ${name}`)
}
