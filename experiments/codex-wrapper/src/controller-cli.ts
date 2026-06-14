#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { WrapperLedger } from "./ledger.js"
import { SelfCompactingCodexController } from "./self-compacting-controller.js"
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
  const prompt = requiredFlag(parsed, "prompt")
  const timeout_ms = Number(lastFlag(parsed, "timeout-ms") ?? DEFAULT_TIMEOUT_MS)
  if (!Number.isFinite(timeout_ms) || timeout_ms <= 0) throw new Error("timeout-ms must be a positive number")
  const result = await state.controller.runTurn(prompt, timeout_ms)
  await mkdir(state.run_dir, { recursive: true })
  await writeFile(state.last_turn_context_path, `${result.model_visible_context}\n`, "utf8")
  if (result.ok) await saveState(state)
  const report = {
    ok: result.ok,
    ...(result.ok ? {} : { error: result.error }),
    assistant: result.assistant,
    thread_id: result.thread_id,
    visible_context_chars: result.visible_context_chars,
    model_visible_context_path: state.last_turn_context_path,
    future_model_visible_context_path: state.visible_context_path,
    n_items_injected: result.n_items_injected,
    n_tool_calls: result.n_tool_calls,
    token_usage: result.token_usage,
    future_state_persisted: result.ok,
  }
  await writeFile(state.last_turn_path, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  printJson({ ...report, last_turn_path: state.last_turn_path })
  if (!result.ok) process.exitCode = 1
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

function printHelp(): void {
  process.stdout.write([
    "pcodx controller CLI",
    "",
    "commands:",
    "  record --role <system|user|assistant|tool> (--text <text>|--text-file <path>) [--source <source>]",
    "  ids",
    "  show",
    "  compact --range <from_msg>..<to_msg> --summary <summary>",
    "  turn --prompt <prompt> [--timeout-ms <ms>]",
    "",
    "shared flags:",
    `  --run-dir <path>      default ${DEFAULT_RUN_DIR}`,
    `  --session-id <id>     default ${DEFAULT_SESSION_ID}`,
    "  --cwd <path>          app-server working directory for turn",
    "",
  ].join("\n"))
}

function isMissingFileError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT"
}

main(process.argv.slice(2)).catch(err => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
