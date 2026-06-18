import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { WrapperLedger } from "./ledger.js"
import { pcodx_startup_instructions } from "./pcodx-instructions.js"
import type { CompactionRecord, LedgerMessage } from "./types.js"

const session_id = process.env.PCODX_SESSION_ID ?? `pcodx-${process.pid}`
const run_dir = process.env.PCODX_RUN_DIR ?? `/tmp/pcodx-runs/${session_id}`
const ledger_path = process.env.PCODX_LEDGER_PATH ?? `${run_dir}/ledger.json`
const visible_context_path = `${dirname(ledger_path)}/rendered-visible-context.txt`
const ledger = loadLedger(ledger_path, session_id)
const server = new McpServer({
  name: "pcodx-partial-compact",
  version: "0.1.0",
})

server.registerTool(
  "partial_compact_instructions",
  {
    title: "Pcodx sidecar recording instructions",
    description: "Explain how to use the pcodx sidecar recording helpers in this worker.",
  },
  () => ({
    content: [
      {
        type: "text",
        text: pcodx_startup_instructions(ledger_path),
      },
    ],
  }),
)

server.registerTool(
  "partial_compact_record_message",
  {
    title: "Record compactable context",
    description: "Append a message to the pcodx sidecar ledger for durable working-memory handoff.",
    inputSchema: {
      role: z.enum(["system", "user", "assistant", "tool"]),
      text: z.string().min(1),
      source: z.string().optional(),
    },
  },
  ({ role, text, source }) => {
    const message = ledger.append(role, text, source)
    saveLedgerArtifacts(ledger_path, ledger)
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          message_id: message.id,
          role: message.role,
          source: message.source,
          text_chars: message.text.length,
          ledger_path,
          visible_context_path,
          native_context_rewritten: false,
        }, null, 2),
      }],
    }
  },
)

server.registerTool(
  "partial_compact_current_ids",
  {
    title: "List visible pcodx message ids",
    description: "Return the current visible ids from the pcodx sidecar ledger.",
  },
  current_session_message_ids,
)

server.registerTool(
  "partial_compact_current_session_message_ids",
  {
    title: "List visible pcodx message ids",
    description: "Compatibility alias for partial_compact_current_ids.",
  },
  current_session_message_ids,
)

function current_session_message_ids() {
  writeVisibleContextArtifact(ledger)
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ok: true,
            visible_message_ids: ledger.currentVisibleMessageIds(),
            ledger_path,
            visible_context_path,
            native_context_rewritten: false,
          },
          null,
          2,
        ),
      },
    ],
  }
}

await server.connect(new StdioServerTransport())

type LedgerSnapshot = {
  session_id?: string
  messages?: LedgerMessage[]
  compactions?: CompactionRecord[]
}

function loadLedger(path: string, fallback_session_id: string): WrapperLedger {
  const loaded = readSnapshot(path)
  const new_ledger = new WrapperLedger(loaded?.session_id ?? fallback_session_id)
  for (const message of loaded?.messages ?? []) {
    new_ledger.append(message.role, message.text, message.source)
  }
  for (const compaction of loaded?.compactions ?? []) {
    const result = new_ledger.partialCompact({
      from_message_id: compaction.from_message_id,
      to_message_id: compaction.to_message_id,
      summary: compaction.summary,
    })
    if (!result.ok) throw new Error(`invalid stored compaction ${compaction.id}: ${result.error}`)
  }
  return new_ledger
}

function readSnapshot(path: string): LedgerSnapshot | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as LedgerSnapshot
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
}

function saveLedgerArtifacts(path: string, ledger_to_save: WrapperLedger): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(ledger_to_save.snapshot(), null, 2) + "\n", "utf-8")
  writeVisibleContextArtifact(ledger_to_save)
}

function writeVisibleContextArtifact(ledger_to_save: WrapperLedger): void {
  mkdirSync(dirname(visible_context_path), { recursive: true })
  writeFileSync(visible_context_path, ledger_to_save.renderVisibleContext("pcodx recorded visible context") + "\n", "utf-8")
}
