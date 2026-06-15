import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { SelfCompactingCodexController } from "./self-compacting-controller.js"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const RUN_DIR = process.env.PCODX_SELF_COMPACT_RUN_DIR ?? join(ROOT, "runs", "self-compact-smoke")
const VISIBLE_BEFORE_PATH = join(RUN_DIR, "visible-before-compaction.txt")
const VISIBLE_AFTER_PATH = join(RUN_DIR, "visible-after-compaction.txt")
const RAW_TURN_CONTEXT_PATH = join(RUN_DIR, "raw-turn-model-visible-context.txt")
const FOLLOW_UP_CONTEXT_PATH = join(RUN_DIR, "follow-up-model-visible-context.txt")
const RESULT_PATH = join(RUN_DIR, "result.json")
const SUMMARY_PHRASE = "green-matrix-5711"
const SUMMARY = `Compacted smoke evidence kept only the durable phrase ${SUMMARY_PHRASE}; raw alpha and beta sentinel lines were stale.`
const MIN_ABSOLUTE_SHRINK_TOKENS = 1000
const MIN_RELATIVE_SHRINK = 0.35

await rm(RUN_DIR, { recursive: true, force: true })
await mkdir(RUN_DIR, { recursive: true })

const controller = new SelfCompactingCodexController({
  session_id: "pcodx-self-compact-smoke",
  system_instructions: [
    "PCODX self-compaction smoke.",
    "When asked to compact, use the partial_compact dynamic tool exactly as requested.",
    "Future turns are reconstructed only from the controller ledger render.",
  ].join("\n"),
})
controller.append("user", "Verify that a PCODX app-server controller can shrink future model-visible context.")
const first = controller.append("tool", bulkyContext("alpha"), "tool:raw-alpha")
const last = controller.append("tool", bulkyContext("beta"), "tool:raw-beta")
controller.append("assistant", "The raw smoke evidence is stale and should be compacted before the next turn.")

const raw_context = controller.renderVisibleContext()
assertRawContext(raw_context)
await writeFile(VISIBLE_BEFORE_PATH, raw_context, "utf8")

const compact_prompt = [
  "Call the partial_compact tool exactly once with these arguments:",
  JSON.stringify({
    ranges: [{
      from_message_id: first.id,
      to_message_id: last.id,
      summary: SUMMARY,
    }],
  }),
  "After the tool result, reply with only PCODX_COMPACTION_DONE.",
].join("\n")
const raw_turn = await controller.runTurn(compact_prompt, 120000)
if (!raw_turn.ok) throw new Error(`raw turn failed: ${raw_turn.error}`)
if (raw_turn.n_tool_calls === 0) throw new Error("Codex did not call the controller compaction tool")
assertRawContext(raw_turn.model_visible_context)
await writeFile(RAW_TURN_CONTEXT_PATH, raw_turn.model_visible_context, "utf8")

const compacted_context = controller.renderVisibleContext()
assertCompactedContext(compacted_context)
await writeFile(VISIBLE_AFTER_PATH, compacted_context, "utf8")

const follow_up = await controller.runTurn(
  `Using only prior context, reply with the durable phrase from the compacted summary and nothing else.`,
  120000,
)
if (!follow_up.ok) throw new Error(`follow-up turn failed: ${follow_up.error}`)
assertCompactedContext(follow_up.model_visible_context)
await writeFile(FOLLOW_UP_CONTEXT_PATH, follow_up.model_visible_context, "utf8")
if (!follow_up.assistant.toLowerCase().includes(SUMMARY_PHRASE)) {
  throw new Error(`compacted summary was not visible in the next turn: ${JSON.stringify(follow_up.assistant)}`)
}

const raw_input_tokens = raw_turn.token_usage.last.inputTokens
const compacted_input_tokens = follow_up.token_usage.last.inputTokens
const shrink_tokens = raw_input_tokens - compacted_input_tokens
const shrink_fraction = raw_input_tokens <= 0 ? 0 : shrink_tokens / raw_input_tokens
if (shrink_tokens < MIN_ABSOLUTE_SHRINK_TOKENS || shrink_fraction < MIN_RELATIVE_SHRINK) {
  throw new Error([
    "self-compaction did not shrink next model-visible context enough",
    `raw_input_tokens=${raw_input_tokens}`,
    `compacted_input_tokens=${compacted_input_tokens}`,
    `shrink_tokens=${shrink_tokens}`,
    `shrink_fraction=${shrink_fraction.toFixed(3)}`,
  ].join(" "))
}

const result = {
  ok: true,
  raw_thread_id: raw_turn.thread_id,
  compacted_thread_id: follow_up.thread_id,
  raw_input_tokens,
  compacted_input_tokens,
  shrink_tokens,
  shrink_fraction,
  n_tool_calls: raw_turn.n_tool_calls,
  raw_context_chars: raw_context.length,
  compacted_context_chars: compacted_context.length,
  follow_up_injected_context_chars: follow_up.model_visible_context.length,
  raw_model_visible_context_path: RAW_TURN_CONTEXT_PATH,
  compacted_model_visible_context_path: FOLLOW_UP_CONTEXT_PATH,
  visible_before_compaction_path: VISIBLE_BEFORE_PATH,
  visible_after_compaction_path: VISIBLE_AFTER_PATH,
  result_path: RESULT_PATH,
  follow_up_assistant: follow_up.assistant.trim(),
}
await writeFile(RESULT_PATH, JSON.stringify(result, null, 2) + "\n", "utf8")
console.log(JSON.stringify(result, null, 2))

function assertRawContext(context: string): void {
  for (const expected of ["PCODX_SELF_COMPACT_RAW_alpha_000", "PCODX_SELF_COMPACT_RAW_beta_259"]) {
    if (!context.includes(expected)) throw new Error(`raw context missing sentinel ${expected}`)
  }
  if (context.includes(SUMMARY_PHRASE)) throw new Error("raw context unexpectedly contains summary phrase")
}

function assertCompactedContext(context: string): void {
  for (const raw of allRawSentinels()) {
    if (context.includes(raw)) throw new Error(`compacted context still contains raw sentinel ${raw}`)
  }
  for (const raw of [
    "stale hidden transcript probe data",
    "this raw line must disappear from the next model-visible context",
  ]) {
    if (context.includes(raw)) throw new Error(`compacted context still contains raw phrase ${raw}`)
  }
  if (!context.includes(SUMMARY_PHRASE)) throw new Error("compacted context missing summary phrase")
  if (!context.includes("<compacted")) throw new Error("compacted context missing compaction marker")
}

function allRawSentinels(): string[] {
  const sentinels: string[] = []
  for (const label of ["alpha", "beta"]) {
    for (let i = 0; i < 260; i += 1) {
      sentinels.push(`PCODX_SELF_COMPACT_RAW_${label}_${i.toString().padStart(3, "0")}`)
    }
  }
  return sentinels
}

function bulkyContext(label: string): string {
  const lines: string[] = []
  for (let i = 0; i < 260; i += 1) {
    lines.push([
      `PCODX_SELF_COMPACT_RAW_${label}_${i.toString().padStart(3, "0")}`,
      "stale hidden transcript probe data",
      "requestTimeoutMs=30000 upstreamDeadlineMs=9000",
      "this raw line must disappear from the next model-visible context",
    ].join(" | "))
  }
  return lines.join("\n")
}
