#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline/promises"
import { WrapperLedger } from "./ledger.js"
import { SelfCompactingCodexController, type SelfCompactingTurnResult } from "./self-compacting-controller.js"
import type { MessageRole, PartialCompactRange } from "./types.js"

type ParsedArgs = {
  command: string
  flags: Map<string, string[]>
}

const DEFAULT_RUN_DIR = "runs/controller-cli"
const DEFAULT_SESSION_ID = "pcodx-controller-cli"
const DEFAULT_TIMEOUT_MS = 90000

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv)
  if (parsed.command === "help" || parsed.flags.has("help")) {
    printHelp()
    return
  }
  const run_dir = resolve(lastFlag(parsed, "run-dir") ?? DEFAULT_RUN_DIR)
  const session_id = lastFlag(parsed, "session-id") ?? DEFAULT_SESSION_ID
  const cwd = resolve(lastFlag(parsed, "cwd") ?? process.cwd())
  const state = await loadState(run_dir, session_id, cwd)

  switch (parsed.command) {
    case "record":
      await commandRecord(state, parsed)
      return
    case "ids":
      await commandIds(state)
      return
    case "show":
      await commandShow(state)
      return
    case "compact":
      await commandCompact(state, parsed)
      return
    case "turn":
      await commandTurn(state, parsed)
      return
    case "interactive":
      await commandInteractive(state, parsed)
      return
    default:
      throw new Error(`unknown command ${parsed.command}`)
  }
}

type ControllerState = {
  run_dir: string
  ledger_path: string
  visible_context_path: string
  last_turn_context_path: string
  last_turn_path: string
  controller: SelfCompactingCodexController
}

type ControllerTurnReport = {
  ok: boolean
  error?: string
  assistant: string
  thread_id: string | null
  visible_context_chars: number
  model_visible_context_path: string
  turn_report_path: string
  future_model_visible_context_path: string
  n_items_injected: number
  n_tool_calls: number
  token_usage: SelfCompactingTurnResult["token_usage"]
  future_state_persisted: boolean
  last_turn_context_path: string
}

async function loadState(run_dir: string, session_id: string, cwd: string): Promise<ControllerState> {
  const ledger_path = join(run_dir, "ledger.json")
  const visible_context_path = join(run_dir, "model-visible-context.txt")
  const last_turn_context_path = join(run_dir, "last-turn-model-visible-context.txt")
  const last_turn_path = join(run_dir, "last-turn.json")
  const ledger = await readLedgerIfPresent(ledger_path)
  const controller = new SelfCompactingCodexController({
    session_id,
    cwd,
    ...(ledger ? { ledger } : {}),
  })
  return { run_dir, ledger_path, visible_context_path, last_turn_context_path, last_turn_path, controller }
}

async function commandRecord(state: ControllerState, parsed: ParsedArgs): Promise<void> {
  const role = parseRole(requiredFlag(parsed, "role"))
  const text = await readTextInput(parsed)
  const source = lastFlag(parsed, "source")
  const msg = state.controller.append(role, text, source)
  await saveState(state)
  printJson({
    ok: true,
    message_id: msg.id,
    visible_message_ids: state.controller.compactableMessageIds(),
    visible_context_chars: state.controller.renderVisibleContext().length,
    ledger_path: state.ledger_path,
  })
}

async function commandIds(state: ControllerState): Promise<void> {
  await saveState(state)
  printJson({
    ok: true,
    visible_message_ids: state.controller.compactableMessageIds(),
    visible_entry_ids: state.controller.currentVisibleMessageIds(),
    visible_context_chars: state.controller.renderVisibleContext().length,
    ledger_path: state.ledger_path,
    model_visible_context_path: state.visible_context_path,
  })
}

async function commandShow(state: ControllerState): Promise<void> {
  await saveState(state)
  printJson({
    ok: true,
    model_visible_context_path: state.visible_context_path,
    visible_context_chars: state.controller.renderVisibleContext().length,
  })
}

async function commandCompact(state: ControllerState, parsed: ParsedArgs): Promise<void> {
  const ranges = parseRanges(parsed)
  const before_context = state.controller.renderVisibleContext()
  const result = state.controller.partialCompactRanges(ranges)
  if (!result.ok) {
    printJson({ ok: false, error: result.error })
    process.exitCode = 1
    return
  }
  const after_context = state.controller.renderVisibleContext()
  await saveState(state)
  printJson({
    ok: true,
    n_ranges_compacted: result.n_ranges_compacted,
    n_messages_replaced: result.n_messages_replaced,
    visible_message_ids: state.controller.compactableMessageIds(),
    visible_entry_ids: state.controller.currentVisibleMessageIds(),
    before_visible_context_chars: before_context.length,
    after_visible_context_chars: after_context.length,
    model_visible_context_path: state.visible_context_path,
    future_model_context_source: "pcodx app-server controller ledger render",
  })
}

async function commandTurn(state: ControllerState, parsed: ParsedArgs): Promise<void> {
  const prompt = await readPromptInput(parsed)
  const timeout_ms = parseTimeoutMs(parsed)
  const report = await runControllerTurn(state, prompt, timeout_ms)
  printJson({ ...report, last_turn_path: state.last_turn_path })
  if (!report.ok) process.exitCode = 1
}

async function commandInteractive(state: ControllerState, parsed: ParsedArgs): Promise<void> {
  const timeout_ms = parseTimeoutMs(parsed)
  await saveState(state)
  printInteractiveBanner(state)
  const initial_prompt = await readOptionalPromptInput(parsed)
  if (initial_prompt !== null) await runInteractiveTurn(state, initial_prompt, timeout_ms)
  const rl = createInterface({ input: stdin, output: stdout, terminal: stdout.isTTY })
  rl.setPrompt("pcodx> ")
  if (stdout.isTTY) rl.prompt()
  try {
    for await (const raw_line of rl) {
      const line = raw_line.trim()
      if (line.length > 0 && await handleInteractiveLine(state, line, timeout_ms)) break
      if (stdout.isTTY) rl.prompt()
    }
  } finally {
    rl.close()
  }
}

async function runControllerTurn(state: ControllerState, prompt: string, timeout_ms: number): Promise<ControllerTurnReport> {
  const controller = cloneController(state.controller)
  const result = await controller.runTurn(prompt, timeout_ms)
  const turn_base_path = join(state.run_dir, "turns", turnArtifactName(result.thread_id))
  const turn_context_path = `${turn_base_path}-model-visible-context.txt`
  const turn_report_path = `${turn_base_path}-report.json`
  await mkdir(state.run_dir, { recursive: true })
  await mkdir(join(state.run_dir, "turns"), { recursive: true })
  await writeFile(turn_context_path, `${result.model_visible_context}\n`, "utf8")
  await writeFile(state.last_turn_context_path, `${result.model_visible_context}\n`, "utf8")
  if (result.ok) {
    state.controller = controller
    await saveState(state)
  }
  const report = {
    ok: result.ok,
    ...(result.ok ? {} : { error: result.error }),
    assistant: result.assistant,
    thread_id: result.thread_id,
    visible_context_chars: result.visible_context_chars,
    model_visible_context_path: turn_context_path,
    turn_report_path,
    future_model_visible_context_path: state.visible_context_path,
    n_items_injected: result.n_items_injected,
    n_tool_calls: result.n_tool_calls,
    token_usage: result.token_usage,
    future_state_persisted: result.ok,
    last_turn_context_path: state.last_turn_context_path,
  }
  await writeFile(turn_report_path, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  await writeFile(state.last_turn_path, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  return report
}

function turnArtifactName(thread_id: string | null): string {
  const base = thread_id ?? `failed-${Date.now()}`
  return base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "turn"
}

function cloneController(controller: SelfCompactingCodexController): SelfCompactingCodexController {
  return new SelfCompactingCodexController({
    session_id: controller.ledger.session_id,
    cwd: controller.cwd,
    system_instructions: controller.system_instructions,
    ledger: WrapperLedger.fromSnapshot(controller.ledger.snapshot()),
  })
}

async function saveState(state: ControllerState): Promise<void> {
  await mkdir(state.run_dir, { recursive: true })
  await writeFile(state.ledger_path, `${JSON.stringify(state.controller.ledger.snapshot(), null, 2)}\n`, "utf8")
  await writeFile(state.visible_context_path, `${state.controller.renderVisibleContext()}\n`, "utf8")
}

async function readLedgerIfPresent(path: string): Promise<WrapperLedger | null> {
  try {
    return WrapperLedger.fromSnapshot(JSON.parse(await readFile(path, "utf8")))
  } catch (err) {
    if (isMissingFileError(err)) return null
    throw err
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  let command = "help"
  const flags = new Map<string, string[]>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) throw new Error("argument parser reached an invalid position")
    if (!arg.startsWith("--")) {
      if (command !== "help") throw new Error(`unexpected positional argument ${arg}`)
      command = arg
      continue
    }
    if (arg === "--help") {
      flags.set("help", ["true"])
      continue
    }
    const eq_idx = arg.indexOf("=")
    const key = eq_idx === -1 ? arg.slice(2) : arg.slice(2, eq_idx)
    const value = eq_idx === -1 ? argv[i + 1] : arg.slice(eq_idx + 1)
    if (!key) throw new Error("flag name must be non-empty")
    if (value === undefined) throw new Error(`flag --${key} requires a value`)
    if (eq_idx === -1) i += 1
    const values = flags.get(key) ?? []
    values.push(value)
    flags.set(key, values)
  }
  return { command, flags }
}

function parseRanges(parsed: ParsedArgs): PartialCompactRange[] {
  const ranges = parsed.flags.get("range") ?? []
  const summaries = parsed.flags.get("summary") ?? []
  if (ranges.length === 0) throw new Error("compact requires at least one --range")
  if (ranges.length !== summaries.length) throw new Error("compact requires one --summary per --range")
  return ranges.map((range, idx) => {
    const parts = range.split("..")
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`invalid range ${range}`)
    return {
      from_message_id: parts[0],
      to_message_id: parts[1],
      summary: summaries[idx] ?? "",
    }
  })
}

function parseRole(value: string): MessageRole {
  if (value === "system" || value === "user" || value === "assistant" || value === "tool") return value
  throw new Error(`invalid role ${value}`)
}

async function readTextInput(parsed: ParsedArgs): Promise<string> {
  const text = lastFlag(parsed, "text")
  const text_file = lastFlag(parsed, "text-file")
  if (text !== undefined && text_file !== undefined) throw new Error("use --text or --text-file, not both")
  if (text !== undefined) return text
  if (text_file !== undefined) return await readFile(text_file, "utf8")
  throw new Error("missing --text or --text-file")
}

async function readPromptInput(parsed: ParsedArgs): Promise<string> {
  const prompt = await readOptionalPromptInput(parsed)
  if (prompt === null) throw new Error("missing --prompt or --prompt-file")
  return prompt
}

async function readOptionalPromptInput(parsed: ParsedArgs): Promise<string | null> {
  const parts: string[] = []
  for (const path of parsed.flags.get("prompt-file") ?? []) {
    parts.push((await readFile(path, "utf8")).trimEnd())
  }
  const prompt = lastFlag(parsed, "prompt")
  if (prompt !== undefined) parts.push(prompt)
  if (parts.length === 0) return null
  return parts.filter(part => part.length > 0).join("\n\n")
}

async function handleInteractiveLine(state: ControllerState, line: string, timeout_ms: number): Promise<boolean> {
  if (line.startsWith("/")) return await handleInteractiveCommand(state, line, timeout_ms)
  await runInteractiveTurn(state, line, timeout_ms)
  return false
}

async function handleInteractiveCommand(state: ControllerState, line: string, timeout_ms: number): Promise<boolean> {
  const { command, rest } = splitFirstToken(line.slice(1))
  switch (command) {
    case "exit":
    case "quit":
      await saveState(state)
      process.stdout.write("bye\n")
      return true
    case "help":
      printInteractiveHelp()
      return false
    case "ids":
      await saveState(state)
      printInteractiveIds(state)
      return false
    case "show":
      await saveState(state)
      printInteractiveContext(state)
      return false
    case "compact":
      await runInteractiveCompact(state, rest)
      return false
    case "record":
      await runInteractiveRecord(state, rest)
      return false
    case "turn":
      if (!rest) process.stdout.write("usage: /turn <prompt>\n")
      else await runInteractiveTurn(state, rest, timeout_ms)
      return false
    default:
      process.stdout.write(`unknown command /${command || ""}; type /help\n`)
      return false
  }
}

async function runInteractiveTurn(state: ControllerState, prompt: string, timeout_ms: number): Promise<void> {
  process.stdout.write("turn started\n")
  const report = await runControllerTurn(state, prompt, timeout_ms)
  const assistant = report.assistant.trim()
  process.stdout.write(`${assistant || "(empty assistant response)"}\n`)
  if (!report.ok) process.stdout.write(`turn failed: ${report.error}\n`)
  const input_tokens = report.token_usage?.last.inputTokens
  const token_text = typeof input_tokens === "number" ? `, input_tokens=${input_tokens}` : ""
  const state_text = report.future_state_persisted ? "state saved" : "state unchanged"
  process.stdout.write(`${state_text}: ${state.visible_context_path}${token_text}\n`)
}

async function runInteractiveCompact(state: ControllerState, rest: string): Promise<void> {
  const { command: range, rest: summary } = splitFirstToken(rest)
  if (!range || !summary) {
    process.stdout.write("usage: /compact <from_msg>..<to_msg> <faithful summary>\n")
    return
  }
  let parsed_range: PartialCompactRange
  try {
    parsed_range = parseInteractiveRange(range, summary)
  } catch (err) {
    process.stdout.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return
  }
  const before_context = state.controller.renderVisibleContext()
  const result = state.controller.partialCompactRanges([parsed_range])
  if (!result.ok) {
    process.stdout.write(`compact failed: ${result.error}\n`)
    return
  }
  const after_context = state.controller.renderVisibleContext()
  await saveState(state)
  process.stdout.write(`compacted ${formatCount(result.n_ranges_compacted, "range")}, ${formatCount(result.n_messages_replaced, "message")}: ${before_context.length} -> ${after_context.length} chars\n`)
  process.stdout.write(`future model context: ${state.visible_context_path}\n`)
}

async function runInteractiveRecord(state: ControllerState, rest: string): Promise<void> {
  const { command: role_text, rest: text } = splitFirstToken(rest)
  if (!role_text || !text) {
    process.stdout.write("usage: /record <system|user|assistant|tool> <text>\n")
    return
  }
  let role: MessageRole
  try {
    role = parseRole(role_text)
  } catch (err) {
    process.stdout.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return
  }
  const msg = state.controller.append(role, text, "interactive:record")
  await saveState(state)
  process.stdout.write(`recorded ${msg.id}; future model context: ${state.visible_context_path}\n`)
}

function parseInteractiveRange(range: string, summary: string): PartialCompactRange {
  const parts = range.split("..")
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`invalid range ${range}`)
  return {
    from_message_id: parts[0],
    to_message_id: parts[1],
    summary,
  }
}

function splitFirstToken(value: string): { command: string; rest: string } {
  const trimmed = value.trim()
  if (!trimmed) return { command: "", rest: "" }
  const idx = trimmed.search(/\s/)
  if (idx === -1) return { command: trimmed, rest: "" }
  return {
    command: trimmed.slice(0, idx),
    rest: trimmed.slice(idx).trim(),
  }
}

function parseTimeoutMs(parsed: ParsedArgs): number {
  const timeout_ms = Number(lastFlag(parsed, "timeout-ms") ?? DEFAULT_TIMEOUT_MS)
  if (!Number.isFinite(timeout_ms) || timeout_ms <= 0) throw new Error("timeout-ms must be a positive number")
  return timeout_ms
}

function requiredFlag(parsed: ParsedArgs, key: string): string {
  const value = lastFlag(parsed, key)
  if (value === undefined) throw new Error(`missing --${key}`)
  return value
}

function lastFlag(parsed: ParsedArgs, key: string): string | undefined {
  const values = parsed.flags.get(key)
  return values?.[values.length - 1]
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function printLines(lines: string[]): void {
  process.stdout.write(`${lines.join("\n")}\n`)
}

function formatCount(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}

function printHelp(): void {
  printLines([
    "pcodx controller CLI",
    "",
    "commands:",
    "  record --role <system|user|assistant|tool> (--text <text>|--text-file <path>) [--source <source>]",
    "  ids",
    "  show",
    "  compact --range <from_msg>..<to_msg> --summary <summary>",
    "  turn (--prompt <prompt>|--prompt-file <path>...) [--timeout-ms <ms>]",
    "  interactive [--prompt <prompt>|--prompt-file <path>...] [--timeout-ms <ms>]",
    "",
    "shared flags:",
    `  --run-dir <path>      default ${DEFAULT_RUN_DIR}`,
    `  --session-id <id>     default ${DEFAULT_SESSION_ID}`,
    "  --cwd <path>          app-server working directory for turn",
    "",
  ])
}

function printInteractiveBanner(state: ControllerState): void {
  printLines([
    "pcodx interactive Codex CLI",
    `run dir: ${state.run_dir}`,
    `future model context: ${state.visible_context_path}`,
    "type /help for commands, /exit to quit",
    "",
  ])
}

function printInteractiveHelp(): void {
  printLines([
    "commands:",
    "  /ids",
    "  /show",
    "  /record <system|user|assistant|tool> <text>",
    "  /compact <from_msg>..<to_msg> <faithful summary>",
    "  /turn <prompt>",
    "  /exit",
    "",
    "plain input sends a Codex turn through the self-compacting controller",
  ])
}

function printInteractiveIds(state: ControllerState): void {
  printLines([
    `visible message ids: ${state.controller.compactableMessageIds().join(", ") || "(none)"}`,
    `visible entry ids: ${state.controller.currentVisibleMessageIds().join(", ") || "(none)"}`,
    `visible context chars: ${state.controller.renderVisibleContext().length}`,
    `future model context: ${state.visible_context_path}`,
  ])
}

function printInteractiveContext(state: ControllerState): void {
  const context = state.controller.renderVisibleContext()
  printLines([
    `visible context chars: ${context.length}`,
    `future model context: ${state.visible_context_path}`,
    "----- context -----",
    context,
    "----- end context -----",
  ])
}

function isMissingFileError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT"
}

main(process.argv.slice(2)).catch(err => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
