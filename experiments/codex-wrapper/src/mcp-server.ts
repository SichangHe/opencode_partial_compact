import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { WrapperLedger } from "./ledger.js"
import { pcodx_startup_instructions } from "./pcodx-instructions.js"
import type { CompactionRecord, LedgerMessage, PartialCompactRange, PartialCompactRangesResult } from "./types.js"

const session_id = process.env.PCODX_SESSION_ID ?? `pcodx-${process.pid}`
const run_dir = process.env.PCODX_RUN_DIR ?? `/tmp/pcodx-runs/${session_id}`
const ledger_path = process.env.PCODX_LEDGER_PATH ?? `${run_dir}/ledger.json`
const visible_context_path = `${dirname(ledger_path)}/rendered-visible-context.txt`
const ledger = loadLedger(ledger_path, session_id)
const compact_range_schema = z.object({
  from_message_id: z.string().min(1),
  to_message_id: z.string().min(1),
  summary: z.string().min(1),
})

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

server.registerTool(
  "partial_compact",
  {
    title: "Partially compact pcodx ledger",
    description: "Replace one or more disjoint ranges of recorded pcodx ledger messages with faithful summaries.",
    inputSchema: {
      ranges: z.array(compact_range_schema).min(1).optional(),
      from_message_id: z.string().min(1).optional(),
      to_message_id: z.string().min(1).optional(),
      summary: z.string().min(1).optional(),
    },
  },
  (args) => {
    const ranges = normalizeCompactionRanges(args)
    const result = Array.isArray(ranges)
      ? ledger.partialCompactRanges(ranges)
      : ranges
    if (result.ok) saveLedgerArtifacts(ledger_path, ledger)
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            compactionReceipt(result),
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

function saveLedgerArtifacts(path: string, ledger_to_save: WrapperLedger): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(ledger_to_save.snapshot(), null, 2) + "\n", "utf-8")
  writeVisibleContextArtifact(ledger_to_save)
}

function writeVisibleContextArtifact(ledger_to_save: WrapperLedger): void {
  mkdirSync(dirname(visible_context_path), { recursive: true })
  writeFileSync(visible_context_path, ledger_to_save.renderVisibleContext("pcodx compacted visible context") + "\n", "utf-8")
}

function normalizeCompactionRanges(args: {
  ranges?: PartialCompactRange[] | undefined
  from_message_id?: string | undefined
  to_message_id?: string | undefined
  summary?: string | undefined
}): PartialCompactRange[] | PartialCompactRangesResult {
  if (args.ranges !== undefined) return args.ranges
  if (
    typeof args.from_message_id === "string" &&
    typeof args.to_message_id === "string" &&
    typeof args.summary === "string"
  ) {
    return [{
      from_message_id: args.from_message_id,
      to_message_id: args.to_message_id,
      summary: args.summary,
    }]
  }
  return { ok: false, error: "provide ranges with from_message_id, to_message_id, and summary" }
}

function compactionReceipt(result: PartialCompactRangesResult): Record<string, unknown> {
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      ledger_path,
      visible_context_path,
      native_context_rewritten: false,
    }
  }
  return {
    ok: true,
    n_ranges_compacted: result.n_ranges_compacted,
    n_messages_replaced: result.n_messages_replaced,
    compactions: result.records.map(record => ({
      id: record.id,
      from_message_id: record.from_message_id,
      to_message_id: record.to_message_id,
      n_messages_replaced: record.n_messages_replaced,
    })),
    visible_message_ids: result.visible_message_ids,
    ledger_path,
    visible_context_path,
    native_context_rewritten: false,
  }
}
