import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { WrapperLedger } from "./ledger.js"
import type { CompactionRecord, LedgerMessage } from "./types.js"

const session_id = process.env.PCODX_SESSION_ID ?? `pcodx-${process.pid}`
const run_dir = process.env.PCODX_RUN_DIR ?? `/tmp/pcodx-runs/${session_id}`
const ledger_path = process.env.PCODX_LEDGER_PATH ?? `${run_dir}/ledger.json`
const ledger = loadLedger(ledger_path, session_id)

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
        text: [
          "pcodx partial compaction is available through MCP tools backed by a sidecar ledger.",
          `ledger_path: ${ledger_path}`,
          "Treat partial compaction as expected context hygiene, not an optional last resort.",
          "Start recording early: use partial_compact_record_message for compactable working memory after startup context, each completed investigation or verifier loop, each resolved detour, and any large command/tool output once its durable takeaway is known.",
          "Expected triggers: compact before asking the manager to compact or resume you, before starting a new broad exploration/verifier loop when prior recorded context is stale, after a commit/push/report phase, after roughly 10 substantive tool or command results without compaction, or whenever context feels crowded enough to slow reasoning.",
          "Concrete action: call partial_compact_current_session_message_ids, choose the oldest contiguous recorded range whose raw text is no longer needed, then call partial_compact with from_message_id, to_message_id, and a faithful summary.",
          "If no recorded range is safe to compact, record a short status message explaining the active goal, preserved constraints, current files, verifier/test state, blockers, and next action so a later compaction has useful material.",
          "After compaction, rely on the returned rendered_visible_context and the ledger artifact for the compacted working memory.",
          "Before exiting a non-trivial task, leave the ledger either compacted or with a clear reason no recorded range was safe to compact.",
          "Caveat: this MCP prototype does not rewrite Codex's hidden native transcript.",
        ].join("\n"),
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
      content: [{ type: "text", text: JSON.stringify({ ok: true, message, ledger_path }, null, 2) }],
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
