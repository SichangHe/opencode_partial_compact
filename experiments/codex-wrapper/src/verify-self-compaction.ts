#!/usr/bin/env bun
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

type Check = {
  name: string
  cmd: string[]
  timeout_ms: number
  parse_json: boolean
  env?: Record<string, string>
}

type CheckResult = {
  name: string
  cmd: string[]
  ok: boolean
  status: number | null
  stdout_path: string
  stderr_path: string
  json?: Record<string, unknown>
  error?: string
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const RUN_ID = process.env.PCODX_VERIFY_RUN_ID ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[^0-9A-Za-z]+/g, "").toLowerCase() + `-${process.pid}`
const RUN_DIR = join(ROOT, "runs", "verify-self-compaction", RUN_ID)
const REPORT_JSON_PATH = join(RUN_DIR, "report.json")
const REPORT_MD_PATH = join(RUN_DIR, "report.md")
const CHECKS: Check[] = [
  { name: "typecheck", cmd: ["bun", "run", "typecheck"], timeout_ms: 120000, parse_json: false },
  { name: "unit-tests", cmd: ["bun", "test"], timeout_ms: 120000, parse_json: false },
  {
    name: "context-shrink-smoke",
    cmd: ["bun", "run", "smoke:context-shrink"],
    timeout_ms: 180000,
    parse_json: true,
    env: { PCODX_CONTEXT_SHRINK_RUN_DIR: join(RUN_DIR, "context-shrink-smoke") },
  },
  {
    name: "self-compacting-controller-smoke",
    cmd: ["bun", "run", "smoke:self-compact"],
    timeout_ms: 180000,
    parse_json: true,
    env: { PCODX_SELF_COMPACT_RUN_DIR: join(RUN_DIR, "self-compact-smoke") },
  },
  {
    name: "controller-cli-smoke",
    cmd: ["bun", "run", "smoke:controller-cli"],
    timeout_ms: 180000,
    parse_json: true,
    env: { PCODX_CONTROLLER_CLI_SMOKE_RUN_DIR: join(RUN_DIR, "controller-cli-smoke") },
  },
]

await mkdir(RUN_DIR, { recursive: true })
const results: CheckResult[] = []
for (const check of CHECKS) {
  const result = await runCheck(check)
  results.push(result)
  if (!result.ok) {
    await writeReports(results, false)
    process.exitCode = 1
    break
  }
}
if (results.every(result => result.ok)) await writeReports(results, true)

async function runCheck(check: Check): Promise<CheckResult> {
  const proc = spawnSync(check.cmd[0] ?? "", check.cmd.slice(1), {
    cwd: ROOT,
    encoding: "utf8",
    timeout: check.timeout_ms,
    env: { ...process.env, ...check.env },
  })
  const stdout = proc.stdout ?? ""
  const stderr = proc.stderr ?? ""
  const stdout_path = join(RUN_DIR, `${check.name}.stdout.log`)
  const stderr_path = join(RUN_DIR, `${check.name}.stderr.log`)
  await writeFile(stdout_path, stdout, "utf8")
  await writeFile(stderr_path, stderr, "utf8")
  const ok = proc.status === 0 && proc.error === undefined
  let json: Record<string, unknown> | undefined
  let error = proc.error?.message
  if (check.parse_json && ok) {
    try {
      json = parseJsonOutput(stdout, check.name)
      await addContextHashes(json)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }
  return {
    name: check.name,
    cmd: check.cmd,
    ok: ok && error === undefined,
    status: proc.status,
    stdout_path,
    stderr_path,
    ...(json === undefined ? {} : { json }),
    ...(error === undefined ? {} : { error }),
  }
}

async function writeReports(results: CheckResult[], ok: boolean): Promise<void> {
  const smoke_results: Record<string, Record<string, unknown>> = {}
  for (const result of results) {
    if (result.json !== undefined) smoke_results[result.name] = result.json
  }
  const report = {
    ok,
    command: "bun run verify:self-compaction",
    run_id: RUN_ID,
    report_json_path: REPORT_JSON_PATH,
    report_md_path: REPORT_MD_PATH,
    checks: results,
    smoke_results,
    acceptance_scope: "controller-owned Codex app-server turns only",
    mcp_sidecar_acceptance: false,
  }
  await writeFile(REPORT_JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  await writeFile(REPORT_MD_PATH, renderMarkdown(report), "utf8")
  console.log(JSON.stringify(report, null, 2))
}

async function addContextHashes(json: Record<string, unknown>): Promise<void> {
  const raw_path = stringValue(json.raw_model_visible_context_path ?? json.baseline_model_visible_context_path)
  const compacted_path = stringValue(json.compacted_model_visible_context_path)
  if (raw_path !== null) json.raw_model_visible_context_sha256 = await sha256File(raw_path)
  if (compacted_path !== null) json.compacted_model_visible_context_sha256 = await sha256File(compacted_path)
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function parseJsonOutput(stdout: string, name: string): Record<string, unknown> {
  const trimmed = stdout.trim()
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start === -1 || end === -1 || end < start) throw new Error(`${name} did not emit a JSON object`)
  const parsed = JSON.parse(trimmed.slice(start, end + 1))
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} JSON output was not an object`)
  }
  return parsed as Record<string, unknown>
}

function renderMarkdown(report: {
  ok: boolean
  command: string
  run_id: string
  report_json_path: string
  report_md_path: string
  checks: CheckResult[]
  smoke_results: Record<string, Record<string, unknown>>
  acceptance_scope: string
  mcp_sidecar_acceptance: boolean
}): string {
  const lines = [
    "# PCODX self-compaction verification",
    "",
    `status: ${report.ok ? "ok" : "failed"}`,
    `command: \`${report.command}\``,
    `run_id: ${report.run_id}`,
    `scope: ${report.acceptance_scope}`,
    `mcp_sidecar_acceptance: ${String(report.mcp_sidecar_acceptance)}`,
    "",
    "## checks",
    "",
    ...report.checks.map(check => [
      `- ${check.name}: ${check.ok ? "ok" : "failed"}`,
      `  - command: \`${check.cmd.join(" ")}\``,
      `  - stdout: \`${check.stdout_path}\``,
      `  - stderr: \`${check.stderr_path}\``,
    ].join("\n")),
    "",
    "## app-server shrink evidence",
    "",
    ...Object.entries(report.smoke_results).flatMap(([name, json]) => renderSmoke(name, json)),
    "",
  ]
  return `${lines.join("\n")}\n`
}

function renderSmoke(name: string, json: Record<string, unknown>): string[] {
  const raw = json.raw_input_tokens ?? json.baseline_input_tokens
  const compacted = json.compacted_input_tokens
  return [
    `- ${name}`,
    `  - raw_input_tokens: ${String(raw)}`,
    `  - compacted_input_tokens: ${String(compacted)}`,
    `  - shrink_tokens: ${String(json.shrink_tokens)}`,
    `  - shrink_fraction: ${String(json.shrink_fraction)}`,
    `  - raw_context_path: ${String(json.raw_model_visible_context_path ?? json.baseline_model_visible_context_path)}`,
    `  - raw_context_sha256: ${String(json.raw_model_visible_context_sha256)}`,
    `  - compacted_context_path: ${String(json.compacted_model_visible_context_path)}`,
    `  - compacted_context_sha256: ${String(json.compacted_model_visible_context_sha256)}`,
    `  - result_path: ${String(json.result_path)}`,
  ]
}
