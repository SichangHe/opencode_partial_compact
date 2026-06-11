import { readFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

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
  await client.callTool({
    name: "partial_compact_record_message",
    arguments: { role: "user", text: "stale observation A", source: "smoke" },
  })
  await client.callTool({
    name: "partial_compact_record_message",
    arguments: { role: "assistant", text: "stale observation B", source: "smoke" },
  })
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
  if (!JSON.stringify(compact).includes("smoke summary replacing two stale observations")) {
    throw new Error("tool result did not include compaction summary")
  }
  console.log(JSON.stringify({ ok: true, run_dir, ledger_path, tools: names }, null, 2))
} finally {
  await client.close()
}
