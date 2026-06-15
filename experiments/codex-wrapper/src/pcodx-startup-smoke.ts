import { pcodx_startup_instructions } from "./pcodx-instructions.js"

const ledger_path = "/tmp/pcodx-startup-smoke-ledger.json"
const proc = Bun.spawnSync({
  cmd: ["pcodx", "debug", "prompt-input", "startup smoke"],
  env: {
    ...process.env,
    PCODX_LEDGER_PATH: ledger_path,
    PCODX_POC_ROOT: process.cwd(),
    PCODX_RUN_DIR: "/tmp/pcodx-startup-smoke-run",
    PCODX_SESSION_ID: "pcodx-startup-smoke",
  },
  stdout: "pipe",
  stderr: "pipe",
})
if (!proc.success) {
  throw new Error(`codex debug prompt-input failed: ${new TextDecoder().decode(proc.stderr)}`)
}
const prompt_items = JSON.parse(new TextDecoder().decode(proc.stdout)) as PromptItem[]
const developer_text = developer_prompt_text(prompt_items)
const expected_tool_names = [
  "mcp__pcodx_partial_compact__partial_compact_record_message",
  "mcp__pcodx_partial_compact__partial_compact_current_ids",
  "mcp__pcodx_partial_compact__partial_compact",
]
for (const expected of [
  "You are running in pcodx, Partial-Compactable cODeX mode.",
  `ledger_path: ${ledger_path}`,
  "Context-window reminder",
  ...expected_tool_names,
]) {
  if (!developer_text.includes(expected)) throw new Error(`missing startup instruction: ${expected}`)
}
for (const expected_tool_name of expected_tool_names) {
  if (expected_tool_name.length > 64) throw new Error(`startup tool name is too long for Codex: ${expected_tool_name}`)
}
if (developer_text.includes("partial_compact_current_session_message_ids")) {
  throw new Error("startup instructions still reference the long current-id tool name")
}
const expected_text = pcodx_startup_instructions(ledger_path)
if (!developer_text.includes(expected_text)) throw new Error("developer prompt does not contain the shared startup instruction")
assert_allows_config(["pcodx", "debug", "prompt-input", "--config", 'model_reasoning_effort="xhigh"', "startup smoke"])
assert_allows_config(["pcodx", "debug", "prompt-input", "--config", "model_reasoning_effort='xhigh'", "startup smoke"])
assert_rejects_config(["pcodx", "debug", "prompt-input", "-c", 'developer_instructions="caller override"', "startup smoke"])
assert_rejects_config(["pcodx", "debug", "prompt-input", "--config", 'developer_instructions = "caller override"', "startup smoke"])
assert_rejects_config(["pcodx", "debug", "prompt-input", "--config", 'model="gpt-5"', "startup smoke"])
assert_rejects_config(["pcodx", "debug", "prompt-input", "--config", 'model_reasoning_effort="xhigh"\ndeveloper_instructions="caller override"', "startup smoke"])
console.log(JSON.stringify({ ok: true, ledger_path }, null, 2))

function developer_prompt_text(prompt_items: PromptItem[]): string {
  return prompt_items
  .filter((item): item is DeveloperPromptItem =>
    item.type === "message" && item.role === "developer" && Array.isArray(item.content))
  .flatMap(item => item.content)
  .filter((content): content is PromptText =>
    typeof content === "object" &&
    content !== null &&
    "type" in content &&
    content.type === "input_text" &&
    "text" in content &&
    typeof content.text === "string")
  .map(content => content.text)
  .join("\n")
}

function assert_rejects_config(cmd: string[]): void {
  const override = Bun.spawnSync({
    cmd,
    env: {
      ...process.env,
      PCODX_LEDGER_PATH: ledger_path,
      PCODX_POC_ROOT: process.cwd(),
      PCODX_RUN_DIR: "/tmp/pcodx-startup-smoke-run",
      PCODX_SESSION_ID: "pcodx-startup-smoke",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (override.success) throw new Error(`pcodx accepted caller config override: ${cmd.join(" ")}`)
  if (!new TextDecoder().decode(override.stderr).includes("pcodx owns Codex config injection")) {
    throw new Error("pcodx config rejection did not explain config ownership")
  }
}

function assert_allows_config(cmd: string[]): void {
  const allowed = Bun.spawnSync({
    cmd,
    env: {
      ...process.env,
      PCODX_LEDGER_PATH: ledger_path,
      PCODX_POC_ROOT: process.cwd(),
      PCODX_RUN_DIR: "/tmp/pcodx-startup-smoke-run",
      PCODX_SESSION_ID: "pcodx-startup-smoke",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!allowed.success) throw new Error(`pcodx rejected allowed config: ${new TextDecoder().decode(allowed.stderr)}`)
  const items = JSON.parse(new TextDecoder().decode(allowed.stdout)) as PromptItem[]
  if (!developer_prompt_text(items).includes(expected_text)) throw new Error("allowed config dropped startup instructions")
}

type PromptItem = {
  type?: string
  role?: string
  content?: unknown
}

type DeveloperPromptItem = {
  type: "message"
  role: "developer"
  content: unknown[]
}

type PromptText = {
  type: "input_text"
  text: string
}
