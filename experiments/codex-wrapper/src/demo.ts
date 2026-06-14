import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { MockCodexAdapter } from "./mock-adapter.js"
import { probeCuratedContextInjection } from "./app-server-adapter.js"
import { WrapperLedger } from "./ledger.js"
import type { AgentAdapter, AgentToolCall } from "./types.js"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const FIXTURE_ROOT = join(ROOT, "fixtures", "demo-repo")
const RUN_DIR = join(ROOT, "runs", "latest")
const SYSTEM_INSTRUCTIONS = [
  "You are Codex behind a partial-compaction wrapper.",
  "Use message ids when requesting context compaction.",
  "Continue the task after compaction using visible summaries and recent raw context.",
].join("\n")

export async function runDemo(adapter: AgentAdapter = new MockCodexAdapter()): Promise<void> {
  await rm(RUN_DIR, { recursive: true, force: true })
  await mkdir(RUN_DIR, { recursive: true })

  const ledger = new WrapperLedger("codex-wrapper-demo")
  ledger.append("user", "Find the production payment API timeout problem and recommend the smallest safe fix.")

  await runAgentRound("01-discovery", ledger, adapter)
  await writeReceipt("visible-before-compaction.txt", ledger.renderVisibleContext(SYSTEM_INSTRUCTIONS))

  await runAgentRound("02-compact", ledger, adapter)
  const injection_probe = await probeCuratedContextInjection(ledger.renderVisibleContext(SYSTEM_INSTRUCTIONS))
  ledger.append("system", renderInjectionProbe(injection_probe), "wrapper")
  await writeReceipt("visible-after-compaction.txt", ledger.renderVisibleContext(SYSTEM_INSTRUCTIONS))

  await runAgentRound("03-continue", ledger, adapter)
  await runAgentRound("04-final", ledger, adapter)

  await writeReceipt("ledger.json", JSON.stringify(ledger.snapshot(), null, 2))
  await writeReceipt("final-report.md", finalAssistantMessage(ledger))
}

async function runAgentRound(label: string, ledger: WrapperLedger, adapter: AgentAdapter): Promise<void> {
  const visible_context = ledger.renderVisibleContext(SYSTEM_INSTRUCTIONS)
  const output = await adapter.runTurn({
    session_id: ledger.session_id,
    visible_context,
    visible_entries: ledger.visibleEntries(),
  })
  ledger.append("assistant", output.assistant_text)
  for (const call of output.tool_calls) {
    await executeToolCall(label, ledger, call)
  }
}

async function executeToolCall(label: string, ledger: WrapperLedger, call: AgentToolCall): Promise<void> {
  switch (call.name) {
    case "read_file": {
      const path = call.args.path
      const text = await readFile(join(FIXTURE_ROOT, path), "utf8")
      ledger.append("tool", `read_file ${path}\n\n${text}`, `tool:${label}`)
      return
    }
    case "current_message_ids":
      ledger.append("tool", `current visible ids: ${ledger.currentVisibleMessageIds().join(", ")}`, `tool:${label}`)
      return
    case "partial_compact": {
      const result = ledger.partialCompactRanges(call.args.ranges)
      ledger.append("tool", `partial_compact result: ${JSON.stringify(result)}`, `tool:${label}`)
      return
    }
  }
}

async function writeReceipt(name: string, text: string): Promise<void> {
  await writeFile(join(RUN_DIR, name), text, "utf8")
}

function finalAssistantMessage(ledger: WrapperLedger): string {
  const msg = [...ledger.messages].reverse().find(message => message.role === "assistant")
  if (!msg) throw new Error("demo produced no assistant message")
  return msg.text
}

function renderInjectionProbe(probe: Awaited<ReturnType<typeof probeCuratedContextInjection>>): string {
  if (!probe.ok) return `codex app-server curated-context injection probe failed: ${probe.error}`
  return [
    "codex app-server curated-context injection probe: ok",
    `userAgent=${probe.user_agent}`,
    `platform=${probe.platform}`,
    `itemsInjected=${probe.n_items_injected}`,
  ].join("; ")
}

if (import.meta.main) {
  await runDemo()
  console.log(`demo receipts written to ${RUN_DIR}`)
}
