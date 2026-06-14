import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const RUN_DIR = join(ROOT, "runs", "controller-cli-smoke")
const SESSION_ID = "pcodx-controller-cli-smoke"
const SUMMARY_PHRASE = "CLI_COMPACTED_SUMMARY_SURVIVES"
const RAW_A = "PCODX_CONTROLLER_CLI_RAW_A"
const RAW_B = "PCODX_CONTROLLER_CLI_RAW_B"

await rm(RUN_DIR, { recursive: true, force: true })
await mkdir(RUN_DIR, { recursive: true })
const raw_a_path = join(RUN_DIR, "raw-a.txt")
const raw_b_path = join(RUN_DIR, "raw-b.txt")
const prompt_path = join(RUN_DIR, "prompt.txt")
await writeFile(raw_a_path, bulkyRaw(RAW_A), "utf8")
await writeFile(raw_b_path, bulkyRaw(RAW_B), "utf8")
await writeFile(prompt_path, "Reply with BASELINE_OK and nothing else. Do not run tools.", "utf8")

const first = cliJson("record", "--role", "tool", "--text-file", raw_a_path)
cliJson("record", "--role", "assistant", "--text", "durable context between stale ranges")
const second = cliJson("record", "--role", "tool", "--text-file", raw_b_path)
const before = cliJson("show")
const baseline = cliJson(
  "turn",
  "--prompt-file",
  prompt_path,
  "--timeout-ms",
  "120000",
)
if (baseline.ok !== true) throw new Error(`controller CLI baseline turn failed: ${JSON.stringify(baseline)}`)
const baseline_context = await readFile(requireString(baseline.model_visible_context_path), "utf8")
if (!baseline_context.includes(RAW_A) || !baseline_context.includes(RAW_B)) {
  throw new Error("baseline model-visible context did not contain raw sentinels")
}
const baseline_tokens = inputTokens(baseline)
const compact = cliJson(
  "compact",
  "--range",
  `${requireString(first.message_id)}..${requireString(first.message_id)}`,
  "--summary",
  `${SUMMARY_PHRASE} first stale range summary`,
  "--range",
  `${requireString(second.message_id)}..${requireString(second.message_id)}`,
  "--summary",
  `${SUMMARY_PHRASE} second stale range summary`,
)
const before_chars = requireNumber(before.visible_context_chars)
const after_chars = requireNumber(compact.after_visible_context_chars)
if (after_chars >= before_chars / 10) {
  throw new Error(`CLI compaction did not shrink visible context enough: before=${before_chars} after=${after_chars}`)
}

const compact_context = await readFile(requireString(compact.model_visible_context_path), "utf8")
assertCompactedContext(compact_context)

const turn = cliJson(
  "turn",
  "--prompt",
  `Using only prior context, reply with ${SUMMARY_PHRASE} and nothing else.`,
  "--timeout-ms",
  "120000",
)
if (turn.ok !== true) throw new Error(`controller CLI turn failed: ${JSON.stringify(turn)}`)
const turn_context = await readFile(requireString(turn.model_visible_context_path), "utf8")
assertCompactedContext(turn_context)
const compacted_tokens = inputTokens(turn)
if (compacted_tokens >= baseline_tokens / 2) {
  throw new Error(`controller CLI app-server input tokens did not shrink enough: baseline=${baseline_tokens} compacted=${compacted_tokens}`)
}

console.log(JSON.stringify({
  ok: true,
  before_visible_context_chars: before_chars,
  after_visible_context_chars: after_chars,
  turn_visible_context_chars: requireNumber(turn.visible_context_chars),
  baseline_input_tokens: baseline_tokens,
  compacted_input_tokens: compacted_tokens,
  shrink_tokens: baseline_tokens - compacted_tokens,
  model_visible_context_path: turn.model_visible_context_path,
  future_model_visible_context_path: turn.future_model_visible_context_path,
}, null, 2))

function cliJson(...args: string[]): Record<string, unknown> {
  const result = Bun.spawnSync({
    cmd: [
      "bun",
      "run",
      join(ROOT, "src", "controller-cli.ts"),
      "--run-dir",
      RUN_DIR,
      "--session-id",
      SESSION_ID,
      ...args,
    ],
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr))
  return requireRecord(JSON.parse(new TextDecoder().decode(result.stdout)))
}

function bulkyRaw(prefix: string): string {
  return Array.from({ length: 1800 }, (_, idx) => `${prefix}_${idx}: this raw line must not reach the next model turn`).join("\n")
}

function assertCompactedContext(context: string): void {
  if (!context.includes(SUMMARY_PHRASE)) throw new Error("compacted context missing summary phrase")
  if (!context.includes("durable context between stale ranges")) throw new Error("compacted context missing durable middle")
  if (context.includes(RAW_A) || context.includes(RAW_B)) throw new Error("raw compacted context reached model-visible context")
}

function inputTokens(turn: Record<string, unknown>): number {
  const token_usage = requireRecord(turn.token_usage)
  const last = requireRecord(token_usage.last)
  const input_tokens = requireNumber(last.inputTokens)
  if (input_tokens <= 0) throw new Error("controller CLI turn did not report input tokens")
  return input_tokens
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected string")
  return value
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number") throw new Error("expected number")
  return value
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object")
  return value as Record<string, unknown>
}
