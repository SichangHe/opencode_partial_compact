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
const ledger = loadLedger(ledger_path, session_id)
const native_context_note = "MCP sidecar compaction does not rewrite the running Codex CLI transcript; actual model-visible shrink requires an app-server controller or manager resume using rendered_visible_context."

const server = new McpServer({
  name: "pcodx-partial-compact",
  version: "0.1.0",
})

server.registerTool(
  "partial_compact_instructions",
  {
    title: "Partial-compaction instructions",
    description: "Explain how to use the pcodx partial-compaction ledger tools in this worker.",
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
    description: "Append a message to the pcodx sidecar ledger so it can later be partially compacted.",
    inputSchema: {
      role: z.enum(["system", "user", "assistant", "tool"]),
      text: z.string().min(1),
      source: z.string().optional(),
    },
  },
  ({ role, text, source }) => {
    const message = ledger.append(role, text, source)
    saveLedger(ledger_path, ledger)
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          message,
          ledger_path,
          native_context_rewritten: false,
          native_context_note,
        }, null, 2),
      }],
    }
  },
)

server.registerTool(
  "partial_compact_current_session_message_ids",
  {
    title: "List visible pcodx message ids",
    description: "Return the current visible ids from the pcodx sidecar ledger.",
  },
  () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: true,
            visible_message_ids: ledger.currentVisibleMessageIds(),
            ledger_path,
            native_context_rewritten: false,
            native_context_note,
            rendered_visible_context: ledger.renderVisibleContext("pcodx compacted visible context"),
          },
          null,
          2,
        ),
      },
    ],
  }),
)

server.registerTool(
  "partial_compact",
  {
    title: "Partially compact pcodx ledger",
    description: "Replace a contiguous range of recorded pcodx ledger messages with a summary.",
    inputSchema: {
      from_message_id: z.string().min(1),
      to_message_id: z.string().min(1),
      summary: z.string().min(1),
    },
  },
  ({ from_message_id, to_message_id, summary }) => {
    const result = ledger.partialCompact({ from_message_id, to_message_id, summary })
    saveLedger(ledger_path, ledger)
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ...result,
              ledger_path,
              native_context_rewritten: false,
              native_context_note,
              rendered_visible_context: ledger.renderVisibleContext("pcodx compacted visible context"),
            },
            null,
            2,
          ),
        },
      ],
    }
  },
)

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

function saveLedger(path: string, ledger_to_save: WrapperLedger): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(ledger_to_save.snapshot(), null, 2) + "\n", "utf-8")
}
