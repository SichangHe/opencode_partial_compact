import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { runCuratedSingleTurnUsage } from "./app-server-adapter.js"
import { WrapperLedger } from "./ledger.js"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const RUN_DIR = process.env.PCODX_CONTEXT_SHRINK_RUN_DIR ?? join(ROOT, "runs", "context-shrink-smoke")
const RAW_CONTEXT_PATH = join(RUN_DIR, "raw-model-visible-context.txt")
const COMPACTED_CONTEXT_PATH = join(RUN_DIR, "compacted-model-visible-context.txt")
const RESULT_PATH = join(RUN_DIR, "result.json")
const SYSTEM_INSTRUCTIONS = "pcodx context-shrink smoke: use the compacted ledger render as prior state."
const SUMMARY_PHRASE = "violet-calendar-5481"
const SUMMARY = `Stale alpha/beta evidence was reviewed; durable code phrase ${SUMMARY_PHRASE} must remain visible after compaction.`
const PROMPT = "What is the durable code phrase from the compacted summary? Reply with only that phrase, or ABSENT if absent. Do not run tools."
const MIN_ABSOLUTE_SHRINK_TOKENS = 1000
const MIN_RELATIVE_SHRINK = 0.4

await rm(RUN_DIR, { recursive: true, force: true })
await mkdir(RUN_DIR, { recursive: true })

const ledger = new WrapperLedger("pcodx-context-shrink-smoke")
ledger.append("user", "Verify that partial compaction reduces the next model-visible context.")
const first = ledger.append("tool", bulkyContext("alpha"), "tool:raw-alpha")
const last = ledger.append("tool", bulkyContext("beta"), "tool:raw-beta")
ledger.append("assistant", "The bulky raw evidence is stale after summarization.")
const raw_context = ledger.renderVisibleContext(SYSTEM_INSTRUCTIONS)
await writeFile(RAW_CONTEXT_PATH, `${raw_context}\n`, "utf8")
const compact = ledger.partialCompact({
  from_message_id: first.id,
  to_message_id: last.id,
  summary: SUMMARY,
})
if (!compact.ok) throw new Error(`ledger compaction failed: ${compact.error}`)
const compacted_context = ledger.renderVisibleContext(SYSTEM_INSTRUCTIONS)
await writeFile(COMPACTED_CONTEXT_PATH, `${compacted_context}\n`, "utf8")
assertContextShape(raw_context, compacted_context)

const raw = await runCuratedSingleTurnUsage(raw_context, PROMPT, 120000)
if (!raw.ok) throw new Error(`raw-context probe failed: ${raw.error}`)
const compacted = await runCuratedSingleTurnUsage(compacted_context, PROMPT, 120000)
if (!compacted.ok) throw new Error(`compacted-context probe failed: ${compacted.error}`)
if (!compacted.assistant.toLowerCase().includes(SUMMARY_PHRASE)) {
  throw new Error(`compacted context summary was not visible to the model: ${JSON.stringify(compacted.assistant)}`)
}

const raw_input_tokens = raw.token_usage.last.inputTokens
const compacted_input_tokens = compacted.token_usage.last.inputTokens
const shrink_tokens = raw_input_tokens - compacted_input_tokens
const shrink_fraction = raw_input_tokens <= 0 ? 0 : shrink_tokens / raw_input_tokens
if (shrink_tokens < MIN_ABSOLUTE_SHRINK_TOKENS || shrink_fraction < MIN_RELATIVE_SHRINK) {
  throw new Error([
    "partial compaction did not shrink model-visible context enough",
    `raw_input_tokens=${raw_input_tokens}`,
    `compacted_input_tokens=${compacted_input_tokens}`,
    `shrink_tokens=${shrink_tokens}`,
    `shrink_fraction=${shrink_fraction.toFixed(3)}`,
  ].join(" "))
}

const result = {
  ok: true,
  raw_thread_id: raw.thread_id,
  compacted_thread_id: compacted.thread_id,
  raw_input_tokens,
  compacted_input_tokens,
  shrink_tokens,
  shrink_fraction,
  raw_context_chars: raw_context.length,
  compacted_context_chars: compacted_context.length,
  raw_model_visible_context_path: RAW_CONTEXT_PATH,
  compacted_model_visible_context_path: COMPACTED_CONTEXT_PATH,
  result_path: RESULT_PATH,
  compacted_assistant: compacted.assistant.trim(),
}
await writeFile(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8")
console.log(JSON.stringify(result, null, 2))

function assertContextShape(raw_context: string, compacted_context: string): void {
  for (const expected of ["PCODX_RAW_CONTEXT_alpha_000", "PCODX_RAW_CONTEXT_beta_259"]) {
    if (!raw_context.includes(expected)) throw new Error(`raw context missing sentinel ${expected}`)
    if (compacted_context.includes(expected)) throw new Error(`compacted context still contains raw sentinel ${expected}`)
  }
  if (raw_context.includes(SUMMARY_PHRASE)) throw new Error("raw context unexpectedly contains summary phrase")
  if (!compacted_context.includes(SUMMARY_PHRASE)) throw new Error("compacted context missing summary phrase")
}

function bulkyContext(label: string): string {
  const lines: string[] = []
  for (let i = 0; i < 260; i += 1) {
    lines.push([
      `PCODX_RAW_CONTEXT_${label}_${i.toString().padStart(3, "0")}`,
      "stale verifier transcript with redundant command output",
      "requestTimeoutMs=30000 upstreamDeadlineMs=9000",
      "this line should disappear from the compacted model-visible context",
    ].join(" | "))
  }
  return lines.join("\n")
}
