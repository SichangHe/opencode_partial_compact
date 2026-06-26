#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { createConnection, createServer } from "node:net"
import { homedir } from "node:os"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { startPcodxFrontendProxy, FRONTEND_ACCEPTANCE_SCOPE, FRONTEND_ACCEPTANCE_SCOPE_TEXT } from "./frontend-proxy.js"

type ParsedArgs = {
  flags: Map<string, string[]>
  codex_args: string[]
}

type ChildCodexSetup = {
  child_codex_home: string
  source_codex_home: string
  config_path: string
  auth_path: string
  auth_strategy: string
  config_values: Record<string, string>
  env: NodeJS.ProcessEnv
}

const DEFAULT_RUN_DIR = "."
const DEFAULT_PROXY_API_KEY = "cligate-local-proxy"
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CHILD_AUTH_MARKER = "pcodx-frontend-proxy"
const AUTH_ENV_KEYS = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_ACCESS_TOKEN"]
const SAFE_TOP_LEVEL_CONFIG_KEYS = [
  "model",
  "model_provider",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "approval_policy",
  "sandbox_mode",
  "chatgpt_base_url",
  "openai_base_url",
  "disable_response_storage",
]
const MANAGED_CONFIG_MARKER = `# pcodx_managed_by = "${CHILD_AUTH_MARKER}"`

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv)
  if (parsed.flags.has("help")) {
    printHelp()
    return
  }
  const run_dir = resolve(lastFlag(parsed, "run-dir") ?? DEFAULT_RUN_DIR)
  const session_id = lastFlag(parsed, "session-id") ?? defaultSessionId(run_dir)
  const cwd = resolve(lastFlag(parsed, "cwd") ?? process.cwd())
  const proxy_port = await choosePort(parsed, "proxy-port")
  const upstream_port = await choosePort(parsed, "upstream-port")
  const proxy_url = `ws://127.0.0.1:${proxy_port}`
  const upstream_url = `ws://127.0.0.1:${upstream_port}`
  const child_codex_home = resolve(lastFlag(parsed, "child-codex-home") ?? join(run_dir, "codex-home"))
  const source_codex_home = resolve(lastFlag(parsed, "source-codex-home") ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"))
  const dry_run = parsed.flags.has("dry-run")
  const selected_model = selectedModel(parsed)
  const pcodx_resume_command = resumeCommand({ run_dir, cwd, session_id })
  const child_setup = await prepareChildCodexSetup({
    child_codex_home,
    source_codex_home,
    run_dir,
    cwd,
    write_files: !dry_run,
  })
  const codex_cmd = ["codex", "--remote", proxy_url, ...codexArgsWithModel(parsed.codex_args, selected_model)]
  const app_server_cmd = ["codex", "app-server", "--listen", upstream_url]
  if (dry_run) {
    printJson({
      ok: true,
      dry_run: true,
      acceptance_scope: FRONTEND_ACCEPTANCE_SCOPE,
      acceptance_scope_text: FRONTEND_ACCEPTANCE_SCOPE_TEXT,
      run_dir,
      session_id,
      source_codex_home: child_setup.source_codex_home,
      child_codex_home: child_setup.child_codex_home,
      child_config_path: child_setup.config_path,
      child_auth_path: child_setup.auth_path,
      child_auth_strategy: child_setup.auth_strategy,
      child_config_values: child_setup.config_values,
      child_env: redactedChildEnv(child_setup.env),
      selected_model,
      upstream_url,
      proxy_url,
      codex_frontend_command: shellCommand(codex_cmd),
      pcodx_session_id: session_id,
      pcodx_resume_command,
      upstream_app_server_command: shellCommand(app_server_cmd),
      slash_command_surface: "native Codex front-end via `codex --remote`; `/review` reaches app-server `review/start`, native `/compact` reaches `thread/compact/start`",
      context_shrink_route: "PCODX proxy handles dynamic `partial_compact`, then starts the next upstream turn on a fresh app-server thread seeded from the compacted ledger render",
    })
    return
  }
  const app_server = spawn(app_server_cmd[0] ?? "", app_server_cmd.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    env: child_setup.env,
  })
  app_server.stderr.on("data", chunk => process.stderr.write(String(chunk)))
  app_server.stdout.on("data", chunk => process.stderr.write(String(chunk)))
  try {
    await waitForPort("127.0.0.1", upstream_port, 10000)
    const proxy = await startPcodxFrontendProxy({
      upstream_url,
      run_dir,
      session_id,
      cwd,
      host: "127.0.0.1",
      port: proxy_port,
    })
    process.stdout.write(`${FRONTEND_ACCEPTANCE_SCOPE_TEXT}\n`)
    process.stdout.write(`pcodx_proxy_url=${proxy.url}\n`)
    process.stdout.write(`pcodx_run_dir=${run_dir}\n`)
    process.stdout.write(`pcodx_child_codex_home=${child_setup.child_codex_home}\n`)
    process.stdout.write(`pcodx_model=${selected_model ?? "source-config-or-codex-default"}\n`)
    process.stdout.write(`pcodx_resume_hint=${pcodx_resume_command}\n`)
    const codex = spawn(codex_cmd[0] ?? "", codex_cmd.slice(1), {
      stdio: "inherit",
      cwd,
      env: child_setup.env,
    })
    const status = await waitForExit(codex)
    proxy.stop()
    process.stdout.write(`pcodx_session_id=${session_id}\n`)
    process.stdout.write(`pcodx_resume_command=${pcodx_resume_command}\n`)
    process.exitCode = status
  } finally {
    app_server.kill("SIGTERM")
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const split_idx = argv.indexOf("--")
  const own_args = split_idx === -1 ? argv : argv.slice(0, split_idx)
  const codex_args = split_idx === -1 ? [] : argv.slice(split_idx + 1)
  const flags = new Map<string, string[]>()
  for (let i = 0; i < own_args.length; i += 1) {
    const arg = own_args[i]
    if (arg === undefined) throw new Error("argument parser reached an invalid position")
    if (arg === "--dry-run" || arg === "--help") {
      flags.set(arg.slice(2), ["true"])
      continue
    }
    if (!arg.startsWith("--")) throw new Error(`unexpected positional argument ${arg}; put Codex args after --`)
    const eq_idx = arg.indexOf("=")
    const key = eq_idx === -1 ? arg.slice(2) : arg.slice(2, eq_idx)
    const value = eq_idx === -1 ? own_args[i + 1] : arg.slice(eq_idx + 1)
    if (!key) throw new Error("flag name must be non-empty")
    if (value === undefined) throw new Error(`flag --${key} requires a value`)
    if (eq_idx === -1) i += 1
    const values = flags.get(key) ?? []
    values.push(value)
    flags.set(key, values)
  }
  return { flags, codex_args }
}

async function prepareChildCodexSetup(input: { child_codex_home: string; source_codex_home: string; run_dir: string; cwd: string; write_files: boolean }): Promise<ChildCodexSetup> {
  const config_values = await readSourceConfigValues(input.source_codex_home)
  const config_text = renderChildConfig(config_values, input.cwd)
  const config_path = join(input.child_codex_home, "config.toml")
  const auth_path = join(input.child_codex_home, "auth.json")
  const auth_strategy = resolveAuthStrategy(config_values)
  const env = childCodexEnv(input.child_codex_home, auth_strategy)
  if (input.write_files) {
    if (auth_strategy !== "local-proxy-api-key") {
      throw new Error("PCODX native front-end launcher requires loopback openai_base_url in the source Codex config")
    }
    await mkdir(input.run_dir, { recursive: true })
    await verifyChildHomePaths(input.child_codex_home, input.source_codex_home, input.run_dir)
    await verifyNoSymlinkLeaf(config_path)
    await verifyNoSymlinkLeaf(auth_path)
    if (existsSync(config_path)) await verifyExistingChildConfig(config_path)
    if (existsSync(auth_path)) await verifyExistingChildAuth(auth_path)
    await mkdir(input.child_codex_home, { recursive: true })
    await writeFile(config_path, config_text, { encoding: "utf8", mode: 0o600 })
    await writeFile(auth_path, renderChildAuth(auth_strategy), { encoding: "utf8", mode: 0o600 })
  }
  return {
    child_codex_home: input.child_codex_home,
    source_codex_home: input.source_codex_home,
    config_path,
    auth_path,
    auth_strategy,
    config_values,
    env,
  }
}

async function readSourceConfigValues(source_codex_home: string): Promise<Record<string, string>> {
  const path = join(source_codex_home, "config.toml")
  const text = await readFile(path, "utf8").catch((err: unknown) => {
    if (isMissingFileError(err)) return ""
    throw err
  })
  return parseSafeTopLevelConfig(text)
}

function parseSafeTopLevelConfig(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(line)
    if (!match) continue
    const [, key, raw_value] = match
    if (key === undefined || raw_value === undefined || !SAFE_TOP_LEVEL_CONFIG_KEYS.includes(key)) continue
    values[key] = raw_value
  }
  return values
}

function renderChildConfig(values: Record<string, string>, cwd: string): string {
  const lines = [MANAGED_CONFIG_MARKER, ...SAFE_TOP_LEVEL_CONFIG_KEYS.flatMap(key => values[key] === undefined ? [] : [`${key} = ${values[key]}`])]
  lines.push("", `[projects.${tomlString(cwd)}]`, `trust_level = "trusted"`, "")
  return lines.join("\n")
}

function resolveAuthStrategy(config_values: Record<string, string>): string {
  if (isLoopbackUrl(tomlStringValue(config_values.openai_base_url))) {
    return "local-proxy-api-key"
  }
  return "dry-run-auth-unresolved"
}

function childCodexEnv(child_codex_home: string, auth_strategy: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: child_codex_home,
  }
  for (const key of AUTH_ENV_KEYS) delete env[key]
  if (auth_strategy === "local-proxy-api-key") {
    env.OPENAI_API_KEY = DEFAULT_PROXY_API_KEY
  }
  return env
}

function renderChildAuth(auth_strategy: string): string {
  if (auth_strategy !== "local-proxy-api-key") {
    throw new Error("PCODX child auth file is only generated for the loopback local-proxy API key")
  }
  return `${JSON.stringify({
    auth_mode: "apikey",
    OPENAI_API_KEY: DEFAULT_PROXY_API_KEY,
    tokens: null,
    last_refresh: null,
    cligate_managed_by: "cligate",
    cligate_bootstrap_mode: "api-key",
    pcodx_managed_by: CHILD_AUTH_MARKER,
  }, null, 2)}\n`
}

async function verifyChildHomePaths(child_codex_home: string, source_codex_home: string, run_dir: string): Promise<void> {
  const child_path = resolve(child_codex_home)
  const source_path = await realpathIfExists(source_codex_home)
  const run_path = await realpathExistingDirectory(run_dir)
  const child_existing_path = await realpathIfExists(child_path)
  const child_resolved_path = child_existing_path ?? await resolveProspectivePath(child_path)
  if (child_path === source_path || child_resolved_path === source_path) {
    throw new Error(`refusing to use source Codex home as child Codex home: ${child_codex_home}`)
  }
  const rel = relative(run_path, child_resolved_path)
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`child Codex home must be inside run_dir: ${child_codex_home}`)
  }
}

async function realpathExistingDirectory(path: string): Promise<string> {
  const real = await realpath(path)
  const info = await stat(real)
  if (!info.isDirectory()) throw new Error(`path must be a directory: ${path}`)
  return real
}

async function resolveProspectivePath(path: string): Promise<string> {
  const parts = resolve(path).split(sep).filter(Boolean)
  let current: string = sep
  for (let i = 0; i < parts.length; i += 1) {
    const candidate = join(current, parts[i] ?? "")
    const real = await realpathIfExists(candidate)
    if (real === null) return join(current, ...parts.slice(i))
    current = real
  }
  return current
}

async function verifyExistingChildConfig(config_path: string): Promise<void> {
  const text = await readFile(config_path, "utf8")
  if (!text.includes(MANAGED_CONFIG_MARKER)) {
    throw new Error(`refusing to overwrite unmanaged child config.toml: ${config_path}`)
  }
}

async function verifyNoSymlinkLeaf(path: string): Promise<void> {
  const info = await lstat(path).catch((err: unknown) => {
    if (isMissingFileError(err)) return null
    throw err
  })
  if (info?.isSymbolicLink()) throw new Error(`refusing to write child Codex symlink path: ${path}`)
}

async function verifyExistingChildAuth(auth_path: string): Promise<void> {
  const parsed: unknown = JSON.parse(await readFile(auth_path, "utf8"))
  if (!isRecord(parsed) || parsed.pcodx_managed_by !== CHILD_AUTH_MARKER || parsed.auth_mode !== "apikey") {
    throw new Error(`refusing to use child Codex home with unmanaged auth.json: ${auth_path}`)
  }
}

async function realpathIfExists(path: string): Promise<string | null> {
  return await realpath(path).catch((err: unknown) => {
    if (isMissingFileError(err)) return null
    throw err
  })
}

function tomlStringValue(raw_value: string | undefined): string | null {
  if (raw_value === undefined) return null
  const trimmed = raw_value.trim()
  const match = /^"((?:[^"\\]|\\.)*)"/.exec(trimmed)
  if (!match) return null
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return null
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function isLoopbackUrl(value: string | null): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]"
  } catch {
    return false
  }
}

function redactedChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {
    CODEX_HOME: env.CODEX_HOME ?? "",
  }
  for (const key of AUTH_ENV_KEYS) {
    result[key] = env[key] === DEFAULT_PROXY_API_KEY ? DEFAULT_PROXY_API_KEY : env[key] ? "<set>" : "<unset>"
  }
  return result
}

async function choosePort(parsed: ParsedArgs, key: string): Promise<number> {
  const value = lastFlag(parsed, key)
  if (value !== undefined) {
    const port = Number(value)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`--${key} must be a TCP port`)
    return port
  }
  return await freePort()
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => {
        if (typeof address === "object" && address !== null) resolvePromise(address.port)
        else reject(new Error("failed to allocate a local TCP port"))
      })
    })
    server.on("error", reject)
  })
}

async function waitForPort(host: string, port: number, timeout_ms: number): Promise<void> {
  const started_ms = Date.now()
  while (Date.now() - started_ms < timeout_ms) {
    if (await canConnect(host, port)) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`timed out waiting for ${host}:${port}`)
}

async function canConnect(host: string, port: number): Promise<boolean> {
  return await new Promise(resolvePromise => {
    const socket = createConnection({ host, port })
    socket.once("connect", () => {
      socket.destroy()
      resolvePromise(true)
    })
    socket.once("error", () => resolvePromise(false))
    socket.setTimeout(500, () => {
      socket.destroy()
      resolvePromise(false)
    })
  })
}

async function waitForExit(proc: ReturnType<typeof spawn>): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    proc.on("error", reject)
    proc.on("exit", code => resolvePromise(code ?? 1))
  })
}

function lastFlag(parsed: ParsedArgs, key: string): string | undefined {
  const values = parsed.flags.get(key)
  return values?.[values.length - 1]
}

function selectedModel(parsed: ParsedArgs): string | null {
  const model = lastFlag(parsed, "model") ?? process.env.PCODX_MODEL ?? null
  if (model !== null && model.trim().length === 0) throw new Error("--model must be non-empty")
  return model
}

function codexArgsWithModel(codex_args: string[], model: string | null): string[] {
  if (model === null) return codex_args
  if (hasCodexModelArg(codex_args)) throw new Error("pass the launch model with pcodx --model, not both pcodx --model and Codex --model/-m")
  return ["--model", model, ...codex_args]
}

function hasCodexModelArg(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--model" || arg.startsWith("--model=") || arg === "-m" || (arg.startsWith("-m") && arg.length > 2)) return true
  }
  return false
}

function shellCommand(parts: string[]): string {
  return parts.map(shellQuote).join(" ")
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

function isMissingFileError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function printHelp(): void {
  process.stdout.write([
    "pcodx Codex front-end proxy launcher",
    "",
    "usage:",
    "  bun run frontend -- [pcodx flags] -- [codex args...]",
    "  bun run frontend -- --dry-run -- --model gpt-5.5",
    "",
    "pcodx flags:",
    `  --run-dir <path>       default ${DEFAULT_RUN_DIR}`,
    "  --session-id <id>      default derived from the run directory name",
    "  --cwd <path>           Codex working directory",
    "  --child-codex-home <path>  child Codex home for spawned native UI and app-server",
    "  --source-codex-home <path> source Codex home to copy non-secret routing defaults from",
    "  --model <model>        launch native Codex with this model; PCODX_MODEL is the env fallback",
    "  --proxy-port <port>    proxy listen port",
    "  --upstream-port <port> upstream app-server listen port",
    "  --dry-run              print commands without launching",
    "",
  ].join("\n"))
}

function defaultSessionId(run_dir: string): string {
  const label = basename(run_dir).trim()
  return label.length > 0 ? label : "pcodx"
}

function resumeCommand(input: { run_dir: string; cwd: string; session_id: string }): string {
  if (input.session_id === defaultSessionId(input.run_dir)) {
    return shellCommand(["pcodx", "resume", "--last"])
  }
  return shellCommand([
    "bun",
    "run",
    join(ROOT, "src", "frontend-cli.ts"),
    "--run-dir",
    input.run_dir,
    "--cwd",
    input.cwd,
    "--session-id",
    input.session_id,
    "--",
    "resume",
    "--last",
  ])
}

main(process.argv.slice(2)).catch(err => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
