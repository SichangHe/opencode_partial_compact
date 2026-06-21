#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { createConnection, createServer } from "node:net"
import { resolve } from "node:path"
import { startPcodxFrontendProxy, FRONTEND_ACCEPTANCE_SCOPE, FRONTEND_ACCEPTANCE_SCOPE_TEXT } from "./frontend-proxy.js"

type ParsedArgs = {
  flags: Map<string, string[]>
  codex_args: string[]
}

const DEFAULT_RUN_DIR = "runs/frontend-proxy"
const DEFAULT_SESSION_ID = "pcodx-frontend"

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv)
  if (parsed.flags.has("help")) {
    printHelp()
    return
  }
  const run_dir = resolve(lastFlag(parsed, "run-dir") ?? DEFAULT_RUN_DIR)
  const session_id = lastFlag(parsed, "session-id") ?? DEFAULT_SESSION_ID
  const cwd = resolve(lastFlag(parsed, "cwd") ?? process.cwd())
  const proxy_port = await choosePort(parsed, "proxy-port")
  const upstream_port = await choosePort(parsed, "upstream-port")
  const proxy_url = `ws://127.0.0.1:${proxy_port}`
  const upstream_url = `ws://127.0.0.1:${upstream_port}`
  const codex_cmd = ["codex", "--remote", proxy_url, ...parsed.codex_args]
  const app_server_cmd = ["codex", "app-server", "--listen", upstream_url]
  if (parsed.flags.has("dry-run")) {
    printJson({
      ok: true,
      dry_run: true,
      acceptance_scope: FRONTEND_ACCEPTANCE_SCOPE,
      acceptance_scope_text: FRONTEND_ACCEPTANCE_SCOPE_TEXT,
      run_dir,
      session_id,
      upstream_url,
      proxy_url,
      codex_frontend_command: shellCommand(codex_cmd),
      upstream_app_server_command: shellCommand(app_server_cmd),
      slash_command_surface: "native Codex front-end via `codex --remote`; `/review` reaches app-server `review/start`, native `/compact` reaches `thread/compact/start`",
      context_shrink_route: "PCODX proxy handles dynamic `partial_compact`, then starts the next upstream turn on a fresh app-server thread seeded from the compacted ledger render",
    })
    return
  }
  const app_server = spawn(app_server_cmd[0] ?? "", app_server_cmd.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
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
    const codex = spawn(codex_cmd[0] ?? "", codex_cmd.slice(1), {
      stdio: "inherit",
      cwd,
    })
    const status = await waitForExit(codex)
    proxy.stop()
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

function shellCommand(parts: string[]): string {
  return parts.map(shellQuote).join(" ")
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function printHelp(): void {
  process.stdout.write([
    "pcodx Codex front-end proxy launcher",
    "",
    "usage:",
    "  bun run frontend -- [codex args...]",
    "  bun run frontend -- --no-alt-screen",
    "",
    "pcodx flags:",
    `  --run-dir <path>       default ${DEFAULT_RUN_DIR}`,
    `  --session-id <id>      default ${DEFAULT_SESSION_ID}`,
    "  --cwd <path>           Codex working directory",
    "  --proxy-port <port>    proxy listen port",
    "  --upstream-port <port> upstream app-server listen port",
    "  --dry-run              print commands without launching",
    "",
  ].join("\n"))
}

main(process.argv.slice(2)).catch(err => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
