#!/usr/bin/env bun
import { stat } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { basename, dirname, join, resolve } from "node:path"
import { homedir, tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

type Args = {
  root: string
  task_file: string
  tmux_session: string
  workdir: string
  window_name: string
  run_root: string
  run_dir: string
  session_id: string
  worker_defaults: string
  include_worker_defaults: boolean
  timeout_ms: string
  dry_run: boolean
}

type RunResult = {
  stdout: string
  stderr: string
}

const POC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const DEFAULT_ROOT = process.env.OMO_WORK_LOGS_ROOT ?? join(homedir(), "work_logs")
const DEFAULT_RUN_ROOT = process.env.PCODX_CONTROLLER_RUN_ROOT ?? join(tmpdir(), "pcodx-controller-agents")
const DEFAULT_WORKER_DEFAULTS = process.env.OMO_WORKER_DEFAULTS ?? join(homedir(), ".config", "omo_manager", "WORKER_DEFAULTS.md")

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv)
  const task_file = resolveTaskFile(args.root, args.task_file)
  const workdir = resolve(args.workdir)
  const task_slug = slugify(basename(task_file, ".md"))
  const default_id = uniqueDefaultId(task_slug)
  const run_dir = resolve(args.run_dir || join(args.run_root, default_id))
  const session_id = args.session_id || default_id
  const window_name = args.window_name || task_slug
  const prompt_files = args.include_worker_defaults ? [resolve(args.worker_defaults), task_file] : [task_file]
  await requireFile(task_file, "task file")
  await requireDir(workdir, "workdir")
  for (const prompt_file of prompt_files) await requireFile(prompt_file, "prompt file")
  const dry_run_target = "<tmux-target-from-new-window>"
  const dry_run_continue_cmd = continueCommand({ run_dir, session_id, workdir, timeout_ms: args.timeout_ms })
  const dry_run_launch_context = launchContext({
    tmux_target: dry_run_target,
    task_file,
    run_dir,
    session_id,
    continue_cmd: shellCommand(dry_run_continue_cmd),
  })
  const dry_run_controller_cmd = controllerCommand({
    run_dir,
    session_id,
    workdir,
    timeout_ms: args.timeout_ms,
    prompt_files,
    launch_context: dry_run_launch_context,
    env: controllerEnv(dry_run_target, task_file, run_dir, session_id),
  })
  if (args.dry_run) {
    printJson({
      ok: true,
      dry_run: true,
      tmux_new_window: ["tmux", "new-window", "-P", "-F", "#{session_name}:#{window_index}", "-t", args.tmux_session, "-n", window_name, "-c", workdir],
      launch_command: shellCommand(dry_run_controller_cmd),
      continue_command: shellCommand(dry_run_continue_cmd),
      run_dir,
      session_id,
      task_file,
      prompt_files,
    })
    return
  }
  if (!args.tmux_session) throw new Error("missing --tmux-session")
  const target = run([
    "tmux",
    "new-window",
    "-P",
    "-F",
    "#{session_name}:#{window_index}",
    "-t",
    args.tmux_session,
    "-n",
    window_name,
    "-c",
    workdir,
  ]).stdout.trim()
  if (!target) throw new Error("tmux did not return a target")
  const continue_cmd = continueCommand({ run_dir, session_id, workdir, timeout_ms: args.timeout_ms })
  const launch_context = launchContext({
    tmux_target: target,
    task_file,
    run_dir,
    session_id,
    continue_cmd: shellCommand(continue_cmd),
  })
  const controller_cmd = controllerCommand({
    run_dir,
    session_id,
    workdir,
    timeout_ms: args.timeout_ms,
    prompt_files,
    launch_context,
    env: controllerEnv(target, task_file, run_dir, session_id),
  })
  run(["tmux", "send-keys", "-t", target, shellCommand(controller_cmd), "Enter"])
  await waitForInitialTurn(target, Number(args.timeout_ms) + 15000)
  printJson({
    ok: true,
    tmux_target: target,
    run_dir,
    session_id,
    task_file,
    prompt_files,
    continue_command: shellCommand(continue_cmd),
    launch_command: shellCommand(controller_cmd),
  })
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    root: DEFAULT_ROOT,
    task_file: "",
    tmux_session: "",
    workdir: process.cwd(),
    window_name: "",
    run_root: DEFAULT_RUN_ROOT,
    run_dir: "",
    session_id: "",
    worker_defaults: DEFAULT_WORKER_DEFAULTS,
    include_worker_defaults: true,
    timeout_ms: "120000",
    dry_run: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) throw new Error("argument parser reached an invalid position")
    switch (arg) {
      case "--root":
        args.root = requiredValue(argv, ++i, arg)
        break
      case "--task-file":
        args.task_file = requiredValue(argv, ++i, arg)
        break
      case "--tmux-session":
        args.tmux_session = requiredValue(argv, ++i, arg)
        break
      case "--workdir":
        args.workdir = requiredValue(argv, ++i, arg)
        break
      case "--window-name":
        args.window_name = requiredValue(argv, ++i, arg)
        break
      case "--run-root":
        args.run_root = requiredValue(argv, ++i, arg)
        break
      case "--run-dir":
        args.run_dir = requiredValue(argv, ++i, arg)
        break
      case "--session-id":
        args.session_id = requiredValue(argv, ++i, arg)
        break
      case "--worker-defaults":
        args.worker_defaults = requiredValue(argv, ++i, arg)
        break
      case "--timeout-ms":
        args.timeout_ms = requiredValue(argv, ++i, arg)
        break
      case "--no-worker-defaults":
        args.include_worker_defaults = false
        break
      case "--dry-run":
        args.dry_run = true
        break
      case "--help":
        printHelp()
        process.exit(0)
      default:
        throw new Error(`unknown argument ${arg}`)
    }
  }
  if (!args.task_file) throw new Error("missing --task-file")
  if (!args.dry_run && !args.tmux_session) throw new Error("missing --tmux-session")
  if (!Number.isFinite(Number(args.timeout_ms)) || Number(args.timeout_ms) <= 0) throw new Error("--timeout-ms must be positive")
  return args
}

function requiredValue(argv: string[], idx: number, flag: string): string {
  const value = argv[idx]
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`)
  return value
}

function resolveTaskFile(root: string, task_file: string): string {
  if (task_file.startsWith("/")) return resolve(task_file)
  return resolve(root, task_file)
}

function controllerCommand(args: {
  run_dir: string
  session_id: string
  workdir: string
  timeout_ms: string
  prompt_files: string[]
  launch_context: string
  env: Record<string, string>
}): string[] {
  const cmd = [
    "env",
    ...Object.entries(args.env).map(([key, value]) => `${key}=${value}`),
    "bun",
    "run",
    join(POC_ROOT, "src", "controller-cli.ts"),
    "--run-dir",
    args.run_dir,
    "--session-id",
    args.session_id,
    "--cwd",
    args.workdir,
    "interactive",
    "--timeout-ms",
    args.timeout_ms,
  ]
  for (const prompt_file of args.prompt_files) cmd.push("--prompt-file", prompt_file)
  cmd.push("--prompt", args.launch_context)
  return cmd
}

function continueCommand(args: {
  run_dir: string
  session_id: string
  workdir: string
  timeout_ms: string
}): string[] {
  return [
    "bun",
    "run",
    join(POC_ROOT, "src", "controller-cli.ts"),
    "--run-dir",
    args.run_dir,
    "--session-id",
    args.session_id,
    "--cwd",
    args.workdir,
    "interactive",
    "--timeout-ms",
    args.timeout_ms,
  ]
}

function controllerEnv(tmux_target: string, task_file: string, run_dir: string, session_id: string): Record<string, string> {
  return {
    PCODX_MANAGER_TMUX_TARGET: tmux_target,
    PCODX_MANAGER_TASK_FILE: task_file,
    PCODX_CONTROLLER_RUN_DIR: run_dir,
    PCODX_CONTROLLER_SESSION_ID: session_id,
  }
}

function launchContext(args: {
  tmux_target: string
  task_file: string
  run_dir: string
  session_id: string
  continue_cmd: string
}): string {
  return `Manager launch context: tmux target=${args.tmux_target}; task file=${args.task_file}; controller run dir=${args.run_dir}; controller session id=${args.session_id}; continue command=${args.continue_cmd}`
}

async function requireFile(path: string, label: string): Promise<void> {
  const info = await stat(path).catch(() => null)
  if (info === null) throw new Error(`${label} not found: ${path}`)
  if (!info.isFile()) throw new Error(`${label} is not a file: ${path}`)
}

async function requireDir(path: string, label: string): Promise<void> {
  const info = await stat(path).catch(() => null)
  if (info === null) throw new Error(`${label} not found: ${path}`)
  if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`)
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)
  return slug || "pcodx-controller-agent"
}

function uniqueDefaultId(task_slug: string): string {
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[^0-9A-Za-z]+/g, "").toLowerCase()
  return `${task_slug}-${stamp}-${process.pid}`
}

function shellCommand(args: string[]): string {
  return args.map(shellQuote).join(" ")
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

function run(args: string[]): RunResult {
  const result = spawnSync(args[0] ?? "", args.slice(1), {
    encoding: "utf8",
    timeout: 10000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${args[0]} failed: ${result.stderr || result.stdout}`)
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

async function waitForInitialTurn(target: string, timeout_ms: number): Promise<void> {
  const deadline_ms = Date.now() + timeout_ms
  let last = ""
  while (Date.now() < deadline_ms) {
    last = run(["tmux", "capture-pane", "-p", "-S", "-80", "-t", target]).stdout
    if (last.includes("turn failed:")) throw new Error(`controller initial turn failed in ${target}; pane left open:\n${last}`)
    if (last.includes("state saved:")) return
    await sleep(250)
  }
  throw new Error(`controller initial turn did not finish in ${target}; pane left open:\n${last}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function printHelp(): void {
  process.stdout.write([
    "pcodx manager agent launcher",
    "",
    "usage:",
    "  bun run manager:agent -- --task-file <task.md> --tmux-session <session> --workdir <dir>",
    "",
    "options:",
    "  --root <dir>              task-file root for relative task paths",
    "  --window-name <name>      tmux window name; default task stem",
    "  --run-root <dir>          default $PCODX_CONTROLLER_RUN_ROOT or OS temp",
    "  --run-dir <dir>           exact controller ledger directory",
    "  --session-id <id>         default fresh task-stem timestamp",
    "  --worker-defaults <file>  default manager worker defaults",
    "  --no-worker-defaults      send only the task file",
    "  --timeout-ms <ms>         controller turn timeout",
    "  --dry-run",
    "",
  ].join("\n"))
}

main(process.argv.slice(2)).catch(err => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
