#!/usr/bin/env bun
import { spawnSync } from "node:child_process"
import { readdir, readFile, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const AGENT_CLI = join(ROOT, "src", "agent-cli.ts")
const CONTROLLER_CLI = join(ROOT, "src", "controller-cli.ts")
const FRONTEND_CLI = join(ROOT, "src", "frontend-cli.ts")
const MANAGER_LAUNCH = join(ROOT, "src", "manager-agent-launch.ts")
const VERIFY = join(ROOT, "src", "verify-self-compaction.ts")
const DEFAULT_RUN_DIR = "runs/controller-cli"
const ACCEPTANCE_SCOPE = "controller-owned app-server turns"
const ACCEPTANCE_SCOPE_TEXT = `acceptance_scope=${ACCEPTANCE_SCOPE}`
const FLAG_HAS_VALUE = new Set([
  "cwd",
  "prompt",
  "prompt-file",
  "proxy-port",
  "range",
  "role",
  "root",
  "run-dir",
  "run-root",
  "session-id",
  "source",
  "summary",
  "task-file",
  "text",
  "text-file",
  "timeout-ms",
  "tmux-session",
  "window-name",
  "workdir",
  "worker-defaults",
  "upstream-port",
])

type JsonRecord = Record<string, unknown>

type CommandSpec = {
  command: string
  args: string[]
}

type EvidenceCandidate = {
  source_json_path: string
  label: string
  mtime_ms: number
  raw_input_tokens: number | null
  baseline_input_tokens: number | null
  compacted_input_tokens: number | null
  follow_up_input_tokens: number | null
  resolved_raw_or_baseline_input_tokens: number | null
  resolved_compacted_or_follow_up_input_tokens: number | null
  shrink_tokens: number | null
  shrink_fraction: number | null
  artifact_paths: JsonRecord
}

async function main(argv: string[]): Promise<void> {
  const spec = parseCommand(argv)
  switch (spec.command) {
    case "start":
      runJson(["bun", "run", MANAGER_LAUNCH, ...spec.args])
      return
    case "continue":
      runContinue(spec.args)
      return
    case "ids":
    case "show":
    case "compact":
    case "turn":
      runJson(["bun", "run", CONTROLLER_CLI, ...spec.args, spec.command])
      return
    case "interactive":
      process.stdout.write(`${ACCEPTANCE_SCOPE_TEXT}\n`)
      runInherit(["bun", "run", CONTROLLER_CLI, ...spec.args, "interactive"])
      return
    case "frontend":
      runFrontend(spec.args)
      return
    case "evidence":
      await commandEvidence(spec.args)
      return
    case "artifacts":
      await commandArtifacts(spec.args)
      return
    case "verify":
      runJson(["bun", "run", VERIFY, ...spec.args])
      return
    case "help":
      printHelp()
      return
    default:
      throw new Error(`unknown command ${spec.command}`)
  }
}

function parseCommand(argv: string[]): CommandSpec {
  const idx = firstCommandIndex(argv)
  if (idx === -1) return { command: "help", args: argv }
  if (argv[idx] === "agent") {
    const next_idx = firstCommandIndex(argv.slice(idx + 1))
    if (next_idx === -1) return { command: "help", args: argv.slice(0, idx) }
    const command_idx = idx + 1 + next_idx
    return { command: argv[command_idx] ?? "help", args: [...argv.slice(0, idx), ...argv.slice(idx + 1, command_idx), ...argv.slice(command_idx + 1)] }
  }
  return { command: argv[idx] ?? "help", args: [...argv.slice(0, idx), ...argv.slice(idx + 1)] }
}

function firstCommandIndex(argv: string[]): number {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) throw new Error("argument parser reached an invalid position")
    if (!arg.startsWith("--")) return i
    const eq_idx = arg.indexOf("=")
    const key = eq_idx === -1 ? arg.slice(2) : arg.slice(2, eq_idx)
    if (eq_idx === -1 && FLAG_HAS_VALUE.has(key)) i += 1
  }
  return -1
}

function runContinue(args: string[]): void {
  const run_dir = lastFlag(args, "run-dir")
  const session_id = lastFlag(args, "session-id")
  if (run_dir === null) throw new Error("agent continue requires --run-dir")
  if (session_id === null) throw new Error("agent continue requires --session-id")
  const cwd = lastFlag(args, "cwd") ?? process.cwd()
  const timeout_ms = lastFlag(args, "timeout-ms") ?? "120000"
  const cmd = [
    "bun",
    "run",
    CONTROLLER_CLI,
    "--run-dir",
    run_dir,
    "--session-id",
    session_id,
    "--cwd",
    cwd,
    "interactive",
    "--timeout-ms",
    timeout_ms,
  ]
  const stable_cmd = stableContinueCommand(run_dir, session_id, cwd, timeout_ms)
  if (hasFlag(args, "dry-run")) {
    printJson({
      ok: true,
      dry_run: true,
      command_name: "agent continue",
      controller_entrypoint: CONTROLLER_CLI,
      run_dir: resolve(run_dir),
      session_id,
      continue_command: shellCommand(stable_cmd),
      controller_command: shellCommand(cmd),
    })
    return
  }
  process.stdout.write(`${ACCEPTANCE_SCOPE_TEXT}\n`)
  runInherit(cmd)
}

function runFrontend(args: string[]): void {
  const dry_run = hasFlag(args, "dry-run")
  const result = spawnSync("bun", ["run", FRONTEND_CLI, ...args], {
    stdio: dry_run ? "pipe" : "inherit",
    encoding: dry_run ? "utf8" : undefined,
    timeout: dry_run ? 30000 : undefined,
  })
  if (dry_run) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
  }
  if (result.error !== undefined) throw result.error
  process.exit(result.status ?? 0)
}

function runJson(cmd: string[]): void {
  const result = spawnSync(cmd[0] ?? "", cmd.slice(1), { encoding: "utf8", timeout: 900000 })
  if (result.stderr) process.stderr.write(result.stderr)
  const stdout = result.stdout ?? ""
  const parsed = parseJsonObject(stdout)
  if (result.status !== 0 || result.error !== undefined) {
    if (parsed === null) {
      if (stdout) process.stdout.write(stdout)
      process.stdout.write(`${ACCEPTANCE_SCOPE_TEXT}\n`)
    } else {
      printJson(parsed)
    }
    if (result.error !== undefined) process.stderr.write(`${result.error.message}\n`)
    process.exit(result.status ?? 1)
  }
  if (parsed === null) {
    process.stdout.write(stdout)
    if (!stdout.includes(ACCEPTANCE_SCOPE_TEXT)) process.stdout.write(`${ACCEPTANCE_SCOPE_TEXT}\n`)
    return
  }
  printJson(parsed)
}

function runInherit(cmd: string[]): void {
  const result = spawnSync(cmd[0] ?? "", cmd.slice(1), { stdio: "inherit" })
  if (result.error !== undefined) throw result.error
  process.exit(result.status ?? 0)
}

async function commandEvidence(args: string[]): Promise<void> {
  const run_dir = resolve(lastFlag(args, "run-dir") ?? DEFAULT_RUN_DIR)
  const candidates = await evidenceCandidates(run_dir)
  candidates.sort((a, b) => b.mtime_ms - a.mtime_ms || a.source_json_path.localeCompare(b.source_json_path) || a.label.localeCompare(b.label))
  const evidence = candidates[0] ?? null
  printJson({
    ok: evidence !== null,
    run_dir,
    evidence,
  })
  if (evidence === null) process.exitCode = 1
}

async function commandArtifacts(args: string[]): Promise<void> {
  const run_dir = resolve(lastFlag(args, "run-dir") ?? DEFAULT_RUN_DIR)
  const files = await listFiles(run_dir).catch((err: unknown) => {
    if (isMissingFileError(err)) return []
    throw err
  })
  const rel_files = files.map(path => path.slice(run_dir.length + 1))
  const per_turn_reports = rel_files.filter(path => path.startsWith("turns/") && path.endsWith("-report.json")).map(path => join(run_dir, path))
  const context_files = rel_files.filter(path => path.endsWith(".txt") && (path.includes("context") || path === "model-visible-context.txt")).map(path => join(run_dir, path))
  printJson({
    ok: true,
    run_dir,
    ledger_path: await existingPath(join(run_dir, "ledger.json")),
    visible_context_path: await existingPath(join(run_dir, "model-visible-context.txt")),
    last_turn_files: [
      await existingPath(join(run_dir, "last-turn.json")),
      await existingPath(join(run_dir, "last-turn-model-visible-context.txt")),
    ].filter((path): path is string => path !== null),
    per_turn_reports,
    context_files,
  })
}

async function evidenceCandidates(run_dir: string): Promise<EvidenceCandidate[]> {
  const paths = (await listFiles(run_dir).catch((err: unknown) => {
    if (isMissingFileError(err)) return []
    throw err
  })).filter(path => path.endsWith(".json"))
  const candidates: EvidenceCandidate[] = []
  const turn_reports: TurnReportEvidence[] = []
  for (const path of paths) {
    const info = await stat(path)
    const json = parseJsonObject(await readFile(path, "utf8"))
    if (json !== null) {
      collectEvidence(candidates, json, path, info.mtimeMs, "")
      const turn_report = turnReportEvidence(path, info.mtimeMs, json)
      if (turn_report !== null) turn_reports.push(turn_report)
    }
  }
  candidates.push(...turnPairEvidence(turn_reports))
  return candidates
}

type TurnReportEvidence = {
  source_json_path: string
  mtime_ms: number
  input_tokens: number
  model_visible_context_path: string | null
}

function collectEvidence(candidates: EvidenceCandidate[], value: unknown, source_json_path: string, mtime_ms: number, label: string): void {
  if (!isRecord(value)) return
  const raw_input_tokens = numberOrNull(value.raw_input_tokens)
  const baseline_input_tokens = numberOrNull(value.baseline_input_tokens)
  const compacted_input_tokens = numberOrNull(value.compacted_input_tokens)
  const follow_up_input_tokens = numberOrNull(value.follow_up_input_tokens)
  const resolved_raw_or_baseline_input_tokens = raw_input_tokens ?? baseline_input_tokens
  const resolved_compacted_or_follow_up_input_tokens = compacted_input_tokens ?? follow_up_input_tokens
  const shrink_tokens = computedShrink(resolved_raw_or_baseline_input_tokens, resolved_compacted_or_follow_up_input_tokens)
  const shrink_fraction = computedFraction(shrink_tokens, resolved_raw_or_baseline_input_tokens)
  const artifact_paths = artifactPaths(value)
  if (hasPositiveTokenPairEvidence(resolved_raw_or_baseline_input_tokens, resolved_compacted_or_follow_up_input_tokens, shrink_tokens)) {
    candidates.push({
      source_json_path,
      label,
      mtime_ms,
      raw_input_tokens,
      baseline_input_tokens,
      compacted_input_tokens,
      follow_up_input_tokens,
      resolved_raw_or_baseline_input_tokens,
      resolved_compacted_or_follow_up_input_tokens,
      shrink_tokens,
      shrink_fraction,
      artifact_paths,
    })
  }
  for (const [key, nested] of Object.entries(value)) {
    if (isRecord(nested)) collectEvidence(candidates, nested, source_json_path, mtime_ms, label ? `${label}.${key}` : key)
  }
}

function hasPositiveTokenPairEvidence(raw: number | null, compacted: number | null, shrink: number | null): boolean {
  return raw !== null && compacted !== null && shrink !== null && shrink > 0
}

function turnReportEvidence(path: string, mtime_ms: number, json: JsonRecord): TurnReportEvidence | null {
  if (!path.endsWith("-report.json")) return null
  const token_usage = json.token_usage
  if (!isRecord(token_usage)) return null
  const last = token_usage.last
  if (!isRecord(last)) return null
  const input_tokens = numberOrNull(last.inputTokens)
  if (input_tokens === null) return null
  const model_visible_context_path = typeof json.model_visible_context_path === "string" ? json.model_visible_context_path : null
  return { source_json_path: path, mtime_ms, input_tokens, model_visible_context_path }
}

function turnPairEvidence(turn_reports: TurnReportEvidence[]): EvidenceCandidate[] {
  const sorted = [...turn_reports].sort((a, b) => a.mtime_ms - b.mtime_ms || a.source_json_path.localeCompare(b.source_json_path))
  const candidates: EvidenceCandidate[] = []
  for (let i = 1; i < sorted.length; i += 1) {
    const baseline = sorted[i - 1]
    const compacted = sorted[i]
    if (baseline === undefined || compacted === undefined) throw new Error("turn report pair index was invalid")
    const shrink_tokens = baseline.input_tokens - compacted.input_tokens
    if (shrink_tokens <= 0) continue
    candidates.push({
      source_json_path: compacted.source_json_path,
      label: "turn-report-pair",
      mtime_ms: compacted.mtime_ms,
      raw_input_tokens: null,
      baseline_input_tokens: baseline.input_tokens,
      compacted_input_tokens: compacted.input_tokens,
      follow_up_input_tokens: null,
      resolved_raw_or_baseline_input_tokens: baseline.input_tokens,
      resolved_compacted_or_follow_up_input_tokens: compacted.input_tokens,
      shrink_tokens,
      shrink_fraction: computedFraction(shrink_tokens, baseline.input_tokens),
      artifact_paths: {
        baseline_turn_report_path: baseline.source_json_path,
        compacted_turn_report_path: compacted.source_json_path,
        ...(baseline.model_visible_context_path === null ? {} : { baseline_model_visible_context_path: baseline.model_visible_context_path }),
        ...(compacted.model_visible_context_path === null ? {} : { compacted_model_visible_context_path: compacted.model_visible_context_path }),
      },
    })
  }
  return candidates
}

function artifactPaths(value: JsonRecord): JsonRecord {
  const paths: JsonRecord = {}
  for (const [key, item] of Object.entries(value)) {
    if (key.endsWith("_path") && typeof item === "string" && item.length > 0) paths[key] = item
  }
  return paths
}

function computedShrink(raw: number | null, compacted: number | null): number | null {
  if (raw === null || compacted === null) return null
  return raw - compacted
}

function computedFraction(shrink: number | null, raw: number | null): number | null {
  if (shrink === null || raw === null || raw <= 0) return null
  return shrink / raw
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

async function existingPath(path: string): Promise<string | null> {
  const info = await stat(path).catch((err: unknown) => {
    if (isMissingFileError(err)) return null
    throw err
  })
  return info?.isFile() ? path : null
}

function parseJsonObject(text: string): JsonRecord | null {
  const trimmed = text.trim()
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start === -1 || end === -1 || end < start) return null
  const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1))
  return isRecord(parsed) ? withScope(parsed) : null
}

function withScope(value: JsonRecord): JsonRecord {
  const acceptance_scope = typeof value.acceptance_scope === "string" ? value.acceptance_scope : ACCEPTANCE_SCOPE
  return {
    ...value,
    acceptance_scope,
    acceptance_scope_text: `acceptance_scope=${acceptance_scope}`,
  }
}

function lastFlag(args: string[], key: string): string | null {
  const prefix = `--${key}=`
  for (let i = args.length - 1; i >= 0; i -= 1) {
    const arg = args[i]
    if (arg === undefined) throw new Error("argument parser reached an invalid position")
    if (arg.startsWith(prefix)) return arg.slice(prefix.length)
    if (arg === `--${key}`) return args[i + 1] ?? null
  }
  return null
}

function hasFlag(args: string[], key: string): boolean {
  return args.includes(`--${key}`)
}

function stableContinueCommand(run_dir: string, session_id: string, cwd: string, timeout_ms: string): string[] {
  return [
    "bun",
    "run",
    AGENT_CLI,
    "continue",
    "--run-dir",
    run_dir,
    "--session-id",
    session_id,
    "--cwd",
    cwd,
    "--timeout-ms",
    timeout_ms,
  ]
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissingFileError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT"
}

function printJson(value: JsonRecord): void {
  process.stdout.write(`${JSON.stringify(withScope(value), null, 2)}\n`)
}

function shellCommand(args: string[]): string {
  return args.map(shellQuote).join(" ")
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

function printHelp(): void {
  process.stdout.write([
    "pcodx controller-owned agent wrapper",
    "",
    "commands:",
    "  agent start --task-file <task.md> --tmux-session <session> [manager launch flags]",
    "  agent continue --run-dir <dir> --session-id <id> [--cwd <dir>] [--dry-run]",
    "  agent frontend [pcodx flags] -- [codex CLI/TUI args]",
    "  ids|show|compact|turn|interactive [controller CLI flags]",
    "  evidence --run-dir <dir>",
    "  artifacts --run-dir <dir>",
    "  verify",
    "",
    ACCEPTANCE_SCOPE_TEXT,
    "stock Codex CLI transcript rewriting is unsupported by this wrapper",
    "",
  ].join("\n"))
}

main(process.argv.slice(2)).catch(err => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.stderr.write(`${ACCEPTANCE_SCOPE_TEXT}\n`)
  process.exit(1)
})
