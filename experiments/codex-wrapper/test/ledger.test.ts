import { describe, expect, it } from "bun:test"
import { WrapperLedger } from "../src/ledger.js"
import { runDemo } from "../src/demo.js"
import { SelfCompactingCodexController } from "../src/self-compacting-controller.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { spawnSync } from "node:child_process"
import {
  CONTEXT_WINDOW_REMINDER_CONTEXT_KEY,
  ContextWindowReminderTracker,
  renderContextWindowReminder,
} from "../src/app-server-adapter.js"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

describe("WrapperLedger", () => {
  it("injects message ids and replaces compacted ranges with summaries", () => {
    const ledger = new WrapperLedger("test-session")
    ledger.append("user", "task")
    const first = ledger.append("assistant", "old exploration")
    const second = ledger.append("tool", "raw stale output")
    ledger.append("assistant", "new useful work")

    const result = ledger.partialCompact({
      from_message_id: first.id,
      to_message_id: second.id,
      summary: "old exploration summary",
    })

    expect(result.ok).toBe(true)
    const context = ledger.renderVisibleContext("system")
    expect(context).toContain(`<message id="msg000001" role="user">`)
    expect(context).toContain(`<compacted id="cmp000001" range="${first.id}..${second.id}">`)
    expect(context).toContain("old exploration summary")
    expect(context).not.toContain("raw stale output")
  })

  it("rejects overlapping ranges", () => {
    const ledger = new WrapperLedger("test-session")
    const first = ledger.append("user", "one")
    const second = ledger.append("assistant", "two")
    const third = ledger.append("tool", "three")
    expect(ledger.partialCompact({
      from_message_id: first.id,
      to_message_id: second.id,
      summary: "summary",
    }).ok).toBe(true)

    const result = ledger.partialCompact({
      from_message_id: second.id,
      to_message_id: third.id,
      summary: "overlap",
    })
    expect(result.ok).toBe(false)
  })

  it("compacts multiple disjoint ranges atomically", () => {
    const ledger = new WrapperLedger("test-session")
    const first = ledger.append("assistant", "stale one")
    const keep = ledger.append("tool", "keep")
    const second = ledger.append("assistant", "stale two")
    const result = ledger.partialCompactRanges([
      { from_message_id: first.id, to_message_id: first.id, summary: "first stale summary" },
      { from_message_id: second.id, to_message_id: second.id, summary: "second stale summary" },
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected compaction success")
    expect(result.n_ranges_compacted).toBe(2)
    expect(result.n_messages_replaced).toBe(2)
    expect(result.visible_message_ids).toEqual(["cmp000001", keep.id, "cmp000002"])
    const context = ledger.renderVisibleContext("system")
    expect(context).toContain("first stale summary")
    expect(context).toContain("second stale summary")
    expect(context).toContain("keep")
    expect(context).not.toContain("stale one")
    expect(context).not.toContain("stale two")
  })

  it("rejects overlapping requested ranges without partial writes", () => {
    const ledger = new WrapperLedger("test-session")
    const first = ledger.append("assistant", "one")
    const second = ledger.append("tool", "two")
    const third = ledger.append("assistant", "three")

    const result = ledger.partialCompactRanges([
      { from_message_id: first.id, to_message_id: second.id, summary: "first summary" },
      { from_message_id: second.id, to_message_id: third.id, summary: "overlap summary" },
    ])

    expect(result.ok).toBe(false)
    expect(ledger.compactions).toHaveLength(0)
    expect(ledger.currentVisibleMessageIds()).toEqual([first.id, second.id, third.id])
  })

  it("loads snapshots with validated ids and references", () => {
    const ledger = new WrapperLedger("test-session")
    const first = ledger.append("tool", "raw")
    ledger.partialCompact({
      from_message_id: first.id,
      to_message_id: first.id,
      summary: "summary",
    })

    const loaded = WrapperLedger.fromSnapshot(ledger.snapshot())
    expect(loaded.currentVisibleMessageIds()).toEqual(["cmp000001"])
    expect(loaded.append("assistant", "next").id).toBe("msg000002")

    const invalid = ledger.snapshot() as {
      compactions: Array<{ from_message_id: string }>
    }
    invalid.compactions[0] = { ...invalid.compactions[0], from_message_id: "msg999999" }
    expect(() => WrapperLedger.fromSnapshot(invalid)).toThrow("references missing from_message_id")
  })
})

describe("pcodx MCP sidecar", () => {
  it("keeps receipts compact and does not expose the broken compaction tool", async () => {
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-mcp-test-"))
    const ledger_path = join(run_dir, "ledger.json")
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", join(ROOT, "src", "mcp-server.ts")],
      env: {
        ...process.env,
        PCODX_LEDGER_PATH: ledger_path,
        PCODX_SESSION_ID: "pcodx-mcp-test",
      },
    })
    const client = new Client({ name: "pcodx-mcp-test", version: "0.1.0" })
    const raw_a = "PCODX_RAW_RECEIPT_SENTINEL_A"
    const raw_b = "PCODX_RAW_RECEIPT_SENTINEL_B"
    try {
      await client.connect(transport)
      const tools = await client.listTools()
      const tool_names = tools.tools.map(tool => tool.name)
      expect(tool_names).toContain("partial_compact_record_message")
      expect(tool_names).toContain("partial_compact_current_ids")
      expect(tool_names).toContain("partial_compact_current_session_message_ids")
      expect(tool_names).toContain("partial_compact_instructions")
      expect(tool_names).not.toContain("partial_compact")
      const removed = await client.callTool({ name: "partial_compact", arguments: {} })
      expect(removed.isError).toBe(true)

      const empty_ids = toolJson(await client.callTool({ name: "partial_compact_current_session_message_ids", arguments: {} }))
      const empty_visible_context_path = requireString(empty_ids.visible_context_path)
      const empty_visible_context = await readFile(empty_visible_context_path, "utf8")
      expect(empty_visible_context).toContain("<system>pcodx recorded visible context</system>")

      const first_raw = await client.callTool({
        name: "partial_compact_record_message",
        arguments: { role: "tool", text: raw_a, source: "test" },
      })
      const first_text = toolText(first_raw)
      expectReceiptHidesVisibleContext(first_text)
      expect(first_text).not.toContain(raw_a)
      const first = toolJson(first_raw)
      await client.callTool({
        name: "partial_compact_record_message",
        arguments: { role: "assistant", text: "durable keep", source: "test" },
      })
      const second_raw = await client.callTool({
        name: "partial_compact_record_message",
        arguments: { role: "tool", text: raw_b, source: "test" },
      })
      const second_text = toolText(second_raw)
      expectReceiptHidesVisibleContext(second_text)
      expect(second_text).not.toContain(raw_b)
      const second = toolJson(second_raw)
      const first_id = requireString(first.message_id)
      const second_id = requireString(second.message_id)

      const ids_text = toolText(await client.callTool({ name: "partial_compact_current_session_message_ids", arguments: {} }))
      expectReceiptHidesVisibleContext(ids_text)
      expect(ids_text).not.toContain(raw_a)
      expect(ids_text).not.toContain(raw_b)

      const current_ids = toolJson(await client.callTool({ name: "partial_compact_current_ids", arguments: {} }))
      expect(current_ids.visible_message_ids).toEqual([first_id, "msg000002", second_id])
      const visible_context = await readFile(requireString(current_ids.visible_context_path), "utf8")
      expect(visible_context).toContain("durable keep")
      expect(visible_context).toContain(raw_a)
      expect(visible_context).toContain(raw_b)
    } finally {
      await client.close()
      await rm(run_dir, { recursive: true, force: true })
    }
  })
})

describe("demo", () => {
  it("continues after partial compaction and writes receipts", async () => {
    await runDemo()
    const before = await readFile(join(ROOT, "runs", "latest", "visible-before-compaction.txt"), "utf8")
    const after = await readFile(join(ROOT, "runs", "latest", "visible-after-compaction.txt"), "utf8")
    const finalReport = await readFile(join(ROOT, "runs", "latest", "final-report.md"), "utf8")

    expect(before).toContain("STALE_LEGACY_AUDIT_BLOCK")
    expect(after).toContain("<compacted")
    expect(after).toContain("codex app-server curated-context injection probe: ok")
    expect(after).not.toContain("STALE_LEGACY_AUDIT_BLOCK")
    expect(finalReport).toContain("production config sets `requestTimeoutMs` to 12000")
    expect(finalReport).toContain("Recommended fix")
  })
})

describe("SelfCompactingCodexController", () => {
  it("renders future app-server history from compacted ledger state", () => {
    const controller = new SelfCompactingCodexController({ session_id: "controller-test" })
    const first = controller.append("tool", "PCODX_RAW_CONTROLLER_SENTINEL_A", "tool:test")
    const last = controller.append("tool", "PCODX_RAW_CONTROLLER_SENTINEL_B", "tool:test")
    const result = controller.partialCompact({
      from_message_id: first.id,
      to_message_id: last.id,
      summary: "controller summary survives",
    })

    expect(result.ok).toBe(true)
    const history = JSON.stringify(controller.historyItems())
    expect(history).toContain("controller summary survives")
    expect(history).not.toContain("PCODX_RAW_CONTROLLER_SENTINEL_A")
    expect(history).not.toContain("PCODX_RAW_CONTROLLER_SENTINEL_B")
    expect(controller.currentVisibleMessageIds()).toEqual(["cmp000001"])
    expect(controller.compactableMessageIds()).toEqual([])
  })
})

describe("controller CLI", () => {
  it("persists selected compaction ranges for the next model-visible context", async () => {
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-controller-cli-test-"))
    const raw_a = "PCODX_CLI_RAW_SENTINEL_A ".repeat(400)
    const raw_b = "PCODX_CLI_RAW_SENTINEL_B ".repeat(400)
    try {
      const first = cliJson(run_dir, "record", "--role", "tool", "--text", raw_a)
      cliJson(run_dir, "record", "--role", "assistant", "--text", "durable middle")
      const second = cliJson(run_dir, "record", "--role", "tool", "--text", raw_b)
      const before = cliJson(run_dir, "show")
      const before_chars = requireNumber(before.visible_context_chars)
      const compact = cliJson(
        run_dir,
        "compact",
        "--range",
        `${requireString(first.message_id)}..${requireString(first.message_id)}`,
        "--summary",
        "first CLI raw sentinel summary",
        "--range",
        `${requireString(second.message_id)}..${requireString(second.message_id)}`,
        "--summary",
        "second CLI raw sentinel summary",
      )
      expect(compact.ok).toBe(true)
      expect(requireNumber(compact.after_visible_context_chars)).toBeLessThan(before_chars / 4)
      const visible_context_path = requireString(compact.model_visible_context_path)
      const visible_context = await readFile(visible_context_path, "utf8")
      expect(visible_context).toContain("first CLI raw sentinel summary")
      expect(visible_context).toContain("second CLI raw sentinel summary")
      expect(visible_context).toContain("durable middle")
      expect(visible_context).not.toContain("PCODX_CLI_RAW_SENTINEL_A")
      expect(visible_context).not.toContain("PCODX_CLI_RAW_SENTINEL_B")
    } finally {
      await rm(run_dir, { recursive: true, force: true })
    }
  })

  it("offers an interactive shell for recording and compacting context", async () => {
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-controller-cli-interactive-test-"))
    try {
      const output = cliText(run_dir, [
        "/record tool PCODX_INTERACTIVE_RAW_SENTINEL",
        "/ids",
        "/compact msg000001..msg000001 interactive raw sentinel summary",
        "/show",
        "/exit",
        "",
      ].join("\n"))
      expect(output).toContain("pcodx interactive Codex CLI")
      expect(output).toContain("recorded msg000001")
      expect(output).toContain("compacted 1 range")
      expect(output).toContain("----- context -----")
      expect(output).toContain("interactive raw sentinel summary")
      expect(output).not.toContain("PCODX_INTERACTIVE_RAW_SENTINEL")
      const visible_context = await readFile(join(run_dir, "model-visible-context.txt"), "utf8")
      expect(visible_context).toContain("interactive raw sentinel summary")
      expect(visible_context).not.toContain("PCODX_INTERACTIVE_RAW_SENTINEL")
    } finally {
      await rm(run_dir, { recursive: true, force: true })
    }
  })
})

describe("manager agent launcher", () => {
  it("builds isolated dry-run commands with launch context", async () => {
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-manager-launch-test-"))
    const task_file = join(run_dir, "task.md")
    const worker_defaults = join(run_dir, "worker-defaults.md")
    const run_root = join(run_dir, "runs")
    await writeFile(task_file, "Validation task.", "utf8")
    await writeFile(worker_defaults, "Worker defaults.", "utf8")
    try {
      const first = managerDryRun(run_dir, task_file, worker_defaults, run_root)
      const second = managerDryRun(run_dir, task_file, worker_defaults, run_root)
      expect(first.ok).toBe(true)
      expect(first.dry_run).toBe(true)
      expect(requireString(first.launch_command)).toContain("--prompt-file")
      expect(requireString(first.launch_command)).toContain(worker_defaults)
      expect(requireString(first.launch_command)).toContain(task_file)
      expect(requireString(first.launch_command)).toContain("Manager launch context:")
      expect(requireString(first.continue_command)).toContain(requireString(first.run_dir))
      expect(requireString(first.continue_command)).toContain(requireString(first.session_id))
      expect(requireString(first.continue_command)).toContain("src/agent-cli.ts")
      expect(requireString(first.run_dir)).not.toBe(requireString(second.run_dir))
      expect(requireString(first.session_id)).not.toBe(requireString(second.session_id))
    } finally {
      await rm(run_dir, { recursive: true, force: true })
    }
  })
})

describe("agent wrapper", () => {
  it("routes start dry-runs through the controller manager launcher", async () => {
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-agent-start-test-"))
    const task_file = join(run_dir, "task.md")
    const worker_defaults = join(run_dir, "worker-defaults.md")
    await writeFile(task_file, "Validation task.", "utf8")
    await writeFile(worker_defaults, "Worker defaults.", "utf8")
    try {
      const result = agentJson(
        "start",
        "--dry-run",
        "--root",
        run_dir,
        "--task-file",
        task_file,
        "--tmux-session",
        "opc",
        "--workdir",
        run_dir,
        "--worker-defaults",
        worker_defaults,
        "--run-root",
        join(run_dir, "runs"),
      )
      expect(result.ok).toBe(true)
      expect(result.acceptance_scope_text).toBe("acceptance_scope=controller-owned app-server turns")
      expect(requireString(result.launch_command)).toContain("src/controller-cli.ts")
      expect(requireString(result.launch_command)).toContain("interactive")
      expect(requireString(result.continue_command)).toContain(requireString(result.run_dir))
      expect(requireString(result.continue_command)).toContain(requireString(result.session_id))
    } finally {
      await rm(run_dir, { recursive: true, force: true })
    }
  })

  it("builds continue commands that preserve run dir and session id", async () => {
    const result = agentJson(
      "continue",
      "--run-dir",
      "/tmp/pcodx-agent-preserve-run",
      "--session-id",
      "session-123",
      "--cwd",
      "/tmp",
      "--dry-run",
    )
    expect(result.ok).toBe(true)
      expect(result.acceptance_scope).toBe("controller-owned app-server turns")
      expect(requireString(result.continue_command)).toContain("--run-dir /tmp/pcodx-agent-preserve-run")
      expect(requireString(result.continue_command)).toContain("--session-id session-123")
      expect(requireString(result.continue_command)).toContain("src/agent-cli.ts")
      expect(requireString(result.controller_command)).toContain("src/controller-cli.ts")
      expect(requireString(result.controller_command)).toContain("interactive")
  })

  it("keeps interactive attached and scoped", async () => {
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-agent-interactive-test-"))
    try {
      const output = agentText(
        [
          "--run-dir",
          run_dir,
          "--session-id",
          "agent-interactive-test",
          "interactive",
        ],
        "/exit\n",
      )
      expect(output).toContain("acceptance_scope=controller-owned app-server turns")
      expect(output).toContain("pcodx interactive Codex CLI")
      expect(output).toContain("bye")
    } finally {
      await rm(run_dir, { recursive: true, force: true })
    }
  })

  it("exposes a Codex front-end proxy route separate from the controller REPL", async () => {
    const source_codex_home = await mkdtemp(join(tmpdir(), "pcodx-source-codex-home-test-"))
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-frontend-dry-run-"))
    try {
      await writeFile(join(source_codex_home, "config.toml"), [
        'model = "gpt-5.5"',
        'chatgpt_base_url = "http://localhost:18181/backend-api/"',
        'openai_base_url = "http://localhost:18181"',
        'preferred_auth_method = "chatgpt"',
        "",
      ].join("\n"), "utf8")
      const result = agentJsonWithEnv(
        {
          OPENAI_API_KEY: "host-openai-key",
          CODEX_API_KEY: "host-codex-key",
          CODEX_ACCESS_TOKEN: "host-codex-token",
          OPENAI_ACCESS_TOKEN: "host-openai-token",
        },
        "frontend",
        "--dry-run",
        "--run-dir",
        run_dir,
        "--source-codex-home",
        source_codex_home,
        "--session-id",
        "frontend-session",
        "--cwd",
        "/tmp",
        "--",
        "--no-alt-screen",
      )
      expect(result.ok).toBe(true)
      expect(result.acceptance_scope).toBe("codex front-end remote app-server proxy")
      expect(result.child_auth_strategy).toBe("local-proxy-api-key")
      const child_config_values = requireRecord(result.child_config_values)
      expect(child_config_values.openai_base_url).toBe('"http://localhost:18181"')
      expect(child_config_values.preferred_auth_method).toBeUndefined()
      const child_env = requireRecord(result.child_env)
      expect(child_env.OPENAI_API_KEY).toBe("cligate-local-proxy")
      expect(child_env.CODEX_API_KEY).toBe("<unset>")
      expect(child_env.CODEX_ACCESS_TOKEN).toBe("<unset>")
      expect(child_env.OPENAI_ACCESS_TOKEN).toBe("<unset>")
      expect(requireString(result.codex_frontend_command)).toContain("codex --remote")
      expect(requireString(result.codex_frontend_command)).toContain("--no-alt-screen")
      expect(requireString(result.slash_command_surface)).toContain("/review")
      expect(requireString(result.context_shrink_route)).toContain("fresh app-server thread")
    } finally {
      await rm(source_codex_home, { recursive: true, force: true })
      await rm(run_dir, { recursive: true, force: true })
    }
  })

  it("refuses to launch with unmanaged child Codex auth", async () => {
    const source_codex_home = await mkdtemp(join(tmpdir(), "pcodx-source-codex-home-test-"))
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-frontend-launch-test-"))
    const child_codex_home = join(run_dir, "codex-home")
    try {
      await mkdir(child_codex_home, { recursive: true })
      await writeFile(join(source_codex_home, "config.toml"), [
        'openai_base_url = "http://localhost:18181"',
        "",
      ].join("\n"), "utf8")
      await writeFile(join(child_codex_home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }), "utf8")
      const result = agentRaw(
        "frontend",
        "--run-dir",
        run_dir,
        "--source-codex-home",
        source_codex_home,
        "--child-codex-home",
        child_codex_home,
        "--",
        "--no-alt-screen",
      )
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("refusing to use child Codex home with unmanaged auth.json")
    } finally {
      await rm(source_codex_home, { recursive: true, force: true })
      await rm(run_dir, { recursive: true, force: true })
    }
  })

  it("keeps front-end dry-run auth unresolved without a loopback source config", async () => {
    const source_codex_home = await mkdtemp(join(tmpdir(), "pcodx-source-codex-home-test-"))
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-frontend-empty-source-test-"))
    try {
      const result = agentJsonWithEnv(
        { OPENAI_API_KEY: "host-key" },
        "frontend",
        "--dry-run",
        "--run-dir",
        run_dir,
        "--source-codex-home",
        source_codex_home,
        "--",
        "--no-alt-screen",
      )
      expect(result.child_auth_strategy).toBe("dry-run-auth-unresolved")
      const child_env = requireRecord(result.child_env)
      expect(child_env.OPENAI_API_KEY).toBe("<unset>")
    } finally {
      await rm(source_codex_home, { recursive: true, force: true })
      await rm(run_dir, { recursive: true, force: true })
    }
  })

  it("keeps front-end dry-run auth unresolved with only chatgpt_base_url", async () => {
    const source_codex_home = await mkdtemp(join(tmpdir(), "pcodx-source-codex-home-test-"))
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-frontend-chatgpt-only-test-"))
    try {
      await writeFile(join(source_codex_home, "config.toml"), [
        'chatgpt_base_url = "http://localhost:18181/backend-api/"',
        "",
      ].join("\n"), "utf8")
      const result = agentJson(
        "frontend",
        "--dry-run",
        "--run-dir",
        run_dir,
        "--source-codex-home",
        source_codex_home,
        "--",
        "--no-alt-screen",
      )
      expect(result.child_auth_strategy).toBe("dry-run-auth-unresolved")
      const child_config_values = requireRecord(result.child_config_values)
      expect(child_config_values.chatgpt_base_url).toBe('"http://localhost:18181/backend-api/"')
      const child_env = requireRecord(result.child_env)
      expect(child_env.OPENAI_API_KEY).toBe("<unset>")
    } finally {
      await rm(source_codex_home, { recursive: true, force: true })
      await rm(run_dir, { recursive: true, force: true })
    }
  })

  it("treats IPv6 loopback openai_base_url as local proxy auth", async () => {
    const source_codex_home = await mkdtemp(join(tmpdir(), "pcodx-source-codex-home-test-"))
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-frontend-ipv6-test-"))
    try {
      await writeFile(join(source_codex_home, "config.toml"), [
        'openai_base_url = "http://[::1]:18181"',
        "",
      ].join("\n"), "utf8")
      const result = agentJson(
        "frontend",
        "--dry-run",
        "--run-dir",
        run_dir,
        "--source-codex-home",
        source_codex_home,
        "--",
        "--no-alt-screen",
      )
      expect(result.child_auth_strategy).toBe("local-proxy-api-key")
      const child_env = requireRecord(result.child_env)
      expect(child_env.OPENAI_API_KEY).toBe("cligate-local-proxy")
    } finally {
      await rm(source_codex_home, { recursive: true, force: true })
      await rm(run_dir, { recursive: true, force: true })
    }
  })

  it("refuses child Codex homes that escape run_dir through symlinks", async () => {
    const source_codex_home = await mkdtemp(join(tmpdir(), "pcodx-source-codex-home-test-"))
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-frontend-symlink-test-"))
    const outside_dir = await mkdtemp(join(tmpdir(), "pcodx-frontend-outside-test-"))
    try {
      await writeFile(join(source_codex_home, "config.toml"), [
        'openai_base_url = "http://localhost:18181"',
        "",
      ].join("\n"), "utf8")
      await symlink(outside_dir, join(run_dir, "escape"))
      const result = agentRaw(
        "frontend",
        "--run-dir",
        run_dir,
        "--source-codex-home",
        source_codex_home,
        "--child-codex-home",
        join(run_dir, "escape", "codex-home"),
        "--",
        "--no-alt-screen",
      )
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("child Codex home must be inside run_dir")
    } finally {
      await rm(source_codex_home, { recursive: true, force: true })
      await rm(run_dir, { recursive: true, force: true })
      await rm(outside_dir, { recursive: true, force: true })
    }
  })

  it("refuses symlinked child Codex auth leaves", async () => {
    const source_codex_home = await mkdtemp(join(tmpdir(), "pcodx-source-codex-home-test-"))
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-frontend-leaf-symlink-test-"))
    const outside_dir = await mkdtemp(join(tmpdir(), "pcodx-frontend-outside-test-"))
    const child_codex_home = join(run_dir, "codex-home")
    try {
      await mkdir(child_codex_home, { recursive: true })
      await writeFile(join(source_codex_home, "config.toml"), [
        'openai_base_url = "http://localhost:18181"',
        "",
      ].join("\n"), "utf8")
      const outside_auth = join(outside_dir, "auth.json")
      await writeFile(outside_auth, "{}", "utf8")
      await symlink(outside_auth, join(child_codex_home, "auth.json"))
      const result = agentRaw(
        "frontend",
        "--run-dir",
        run_dir,
        "--source-codex-home",
        source_codex_home,
        "--",
        "--no-alt-screen",
      )
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("refusing to write child Codex symlink path")
    } finally {
      await rm(source_codex_home, { recursive: true, force: true })
      await rm(run_dir, { recursive: true, force: true })
      await rm(outside_dir, { recursive: true, force: true })
    }
  })

  it("summarizes evidence and artifacts from a controller run directory", async () => {
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-agent-evidence-test-"))
    const turns_dir = join(run_dir, "turns")
    const report_path = join(turns_dir, "thread-1-report.json")
    try {
      await writeFile(join(run_dir, "ledger.json"), "{}", "utf8")
      await writeFile(join(run_dir, "model-visible-context.txt"), "future context", "utf8")
      await writeFile(join(run_dir, "last-turn-model-visible-context.txt"), "last context", "utf8")
      await mkdir(turns_dir, { recursive: true })
      await writeFile(join(turns_dir, "thread-1-model-visible-context.txt"), "turn context", "utf8")
      await writeFile(report_path, JSON.stringify({
        baseline_input_tokens: 1000,
        compacted_input_tokens: 250,
        shrink_tokens: 750,
        shrink_fraction: 0.75,
        baseline_model_visible_context_path: join(turns_dir, "baseline.txt"),
        compacted_model_visible_context_path: join(turns_dir, "thread-1-model-visible-context.txt"),
      }), "utf8")
      await writeFile(join(run_dir, "last-turn.json"), JSON.stringify({
        model_visible_context_path: join(turns_dir, "thread-1-model-visible-context.txt"),
        future_model_visible_context_path: join(run_dir, "model-visible-context.txt"),
        shrink_tokens: 9999,
      }), "utf8")

      const evidence = agentJson("evidence", "--run-dir", run_dir)
      expect(evidence.ok).toBe(true)
      const evidence_body = requireRecord(evidence.evidence)
      expect(evidence_body.source_json_path).toBe(report_path)
      expect(evidence_body.baseline_input_tokens).toBe(1000)
      expect(evidence_body.compacted_input_tokens).toBe(250)
      expect(evidence_body.shrink_tokens).toBe(750)

      const artifacts = agentJson("artifacts", "--run-dir", run_dir)
      expect(artifacts.ok).toBe(true)
      expect(requireString(artifacts.ledger_path)).toBe(join(run_dir, "ledger.json"))
      expect(requireStringArray(artifacts.per_turn_reports)).toContain(report_path)
      expect(requireStringArray(artifacts.context_files)).toContain(join(turns_dir, "thread-1-model-visible-context.txt"))
      expect(requireStringArray(artifacts.last_turn_files)).toContain(join(run_dir, "last-turn.json"))
    } finally {
      await rm(run_dir, { recursive: true, force: true })
    }
  })

  it("rejects evidence without a positive app-server token pair", async () => {
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-agent-no-evidence-test-"))
    const turns_dir = join(run_dir, "turns")
    try {
      await mkdir(turns_dir, { recursive: true })
      await writeFile(join(run_dir, "artifact-only.json"), JSON.stringify({ shrink_tokens: 100, shrink_fraction: 0.5, result_path: "artifact.txt" }), "utf8")
      await writeFile(join(turns_dir, "thread-a-report.json"), JSON.stringify(turnReportFixture(300, join(turns_dir, "thread-a-model-visible-context.txt"))), "utf8")
      await writeFile(join(turns_dir, "thread-b-report.json"), JSON.stringify(turnReportFixture(1200, join(turns_dir, "thread-b-model-visible-context.txt"))), "utf8")

      const result = agentRaw("evidence", "--run-dir", run_dir)
      expect(result.status).not.toBe(0)
      const output = requireRecord(JSON.parse(result.stdout))
      expect(output.ok).toBe(false)
      expect(output.evidence).toBeNull()
      expect(output.acceptance_scope_text).toBe("acceptance_scope=controller-owned app-server turns")
    } finally {
      await rm(run_dir, { recursive: true, force: true })
    }
  })

  it("derives explicit evidence shrink from token pairs", async () => {
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-agent-explicit-evidence-test-"))
    try {
      await writeFile(join(run_dir, "inconsistent-positive.json"), JSON.stringify({
        baseline_input_tokens: 100,
        compacted_input_tokens: 50,
        shrink_tokens: 9999,
        shrink_fraction: 9999,
      }), "utf8")
      const evidence = agentJson("evidence", "--run-dir", run_dir)
      const evidence_body = requireRecord(evidence.evidence)
      expect(evidence_body.baseline_input_tokens).toBe(100)
      expect(evidence_body.compacted_input_tokens).toBe(50)
      expect(evidence_body.shrink_tokens).toBe(50)
      expect(evidence_body.shrink_fraction).toBe(0.5)
    } finally {
      await rm(run_dir, { recursive: true, force: true })
    }
  })

  it("rejects explicit evidence when token pair does not shrink", async () => {
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-agent-negative-explicit-evidence-test-"))
    try {
      await writeFile(join(run_dir, "inconsistent-negative.json"), JSON.stringify({
        baseline_input_tokens: 100,
        compacted_input_tokens: 200,
        shrink_tokens: 1,
      }), "utf8")
      const result = agentRaw("evidence", "--run-dir", run_dir)
      expect(result.status).not.toBe(0)
      const output = requireRecord(JSON.parse(result.stdout))
      expect(output.ok).toBe(false)
      expect(output.evidence).toBeNull()
    } finally {
      await rm(run_dir, { recursive: true, force: true })
    }
  })

  it("derives evidence from ordinary per-turn reports", async () => {
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-agent-turn-evidence-test-"))
    const turns_dir = join(run_dir, "turns")
    const baseline_report_path = join(turns_dir, "thread-a-report.json")
    const compacted_report_path = join(turns_dir, "thread-b-report.json")
    try {
      await mkdir(turns_dir, { recursive: true })
      await writeFile(join(turns_dir, "thread-a-model-visible-context.txt"), "raw context", "utf8")
      await writeFile(join(turns_dir, "thread-b-model-visible-context.txt"), "compacted context", "utf8")
      await writeFile(baseline_report_path, JSON.stringify(turnReportFixture(1200, join(turns_dir, "thread-a-model-visible-context.txt"))), "utf8")
      await writeFile(compacted_report_path, JSON.stringify(turnReportFixture(300, join(turns_dir, "thread-b-model-visible-context.txt"))), "utf8")
      await writeFile(join(run_dir, "last-turn.json"), JSON.stringify({ model_visible_context_path: join(turns_dir, "thread-b-model-visible-context.txt") }), "utf8")

      const evidence = agentJson("evidence", "--run-dir", run_dir)
      expect(evidence.ok).toBe(true)
      const evidence_body = requireRecord(evidence.evidence)
      expect(evidence_body.label).toBe("turn-report-pair")
      expect(evidence_body.baseline_input_tokens).toBe(1200)
      expect(evidence_body.compacted_input_tokens).toBe(300)
      expect(evidence_body.shrink_tokens).toBe(900)
      const artifact_paths = requireRecord(evidence_body.artifact_paths)
      expect(artifact_paths.baseline_turn_report_path).toBe(baseline_report_path)
      expect(artifact_paths.compacted_turn_report_path).toBe(compacted_report_path)
    } finally {
      await rm(run_dir, { recursive: true, force: true })
    }
  })

  it("keeps scope on routed command failures", async () => {
    const run_dir = await mkdtemp(join(tmpdir(), "pcodx-agent-failure-test-"))
    try {
      const result = agentRaw("compact", "--run-dir", run_dir, "--session-id", "agent-failure-test", "--range", "msg999999..msg999999", "--summary", "missing")
      expect(result.status).not.toBe(0)
      expect(result.stdout).toContain("acceptance_scope=controller-owned app-server turns")
    } finally {
      await rm(run_dir, { recursive: true, force: true })
    }
  })

  it("keeps scope on wrapper validation failures", () => {
    const result = agentRaw("continue", "--session-id", "missing-run-dir")
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("agent continue requires --run-dir")
    expect(result.stderr).toContain("acceptance_scope=controller-owned app-server turns")
  })
})

describe("context window reminders", () => {
  it("renders app-server token usage as turn additional context", () => {
    const tracker = new ContextWindowReminderTracker()
    const event = observeTokenUsage(tracker, 81000)

    expect(event?.usage.last.inputTokens).toBe(81000)
    const additional_context = tracker.additionalContext("thread-1")
    const reminder = additional_context?.[CONTEXT_WINDOW_REMINDER_CONTEXT_KEY]
    expect(reminder?.kind).toBe("application")
    expect(reminder?.value).toContain("81%")
    expect(reminder?.value).toContain("record durable state now")
  })

  it("gates app-server reminders by token-growth cadence", () => {
    const tracker = new ContextWindowReminderTracker()
    observeTokenUsage(tracker, 15999)
    expect(tracker.additionalContext("thread-1")).toBeUndefined()

    observeTokenUsage(tracker, 16000)
    const first_reminder = tracker.additionalContext("thread-1")?.[CONTEXT_WINDOW_REMINDER_CONTEXT_KEY]
    expect(first_reminder?.value).toContain("16%")
    expect(tracker.additionalContext("thread-1")).toBeUndefined()

    observeTokenUsage(tracker, 31999)
    expect(tracker.additionalContext("thread-1")).toBeUndefined()

    observeTokenUsage(tracker, 32000)
    const second_reminder = tracker.additionalContext("thread-1")?.[CONTEXT_WINDOW_REMINDER_CONTEXT_KEY]
    expect(second_reminder?.value).toContain("32%")
  })

  it("resets app-server reminder cadence after context shrink", () => {
    const tracker = new ContextWindowReminderTracker()
    observeTokenUsage(tracker, 40000)
    expect(tracker.additionalContext("thread-1")).toBeDefined()

    observeTokenUsage(tracker, 10000)
    expect(tracker.additionalContext("thread-1")).toBeUndefined()

    observeTokenUsage(tracker, 25999)
    expect(tracker.additionalContext("thread-1")).toBeUndefined()

    observeTokenUsage(tracker, 26000)
    expect(tracker.additionalContext("thread-1")).toBeDefined()
  })

  it("ignores malformed token usage notifications", () => {
    const tracker = new ContextWindowReminderTracker()
    expect(tracker.observe("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: { last: {}, total: {}, modelContextWindow: 100000 },
    })).toBeNull()
    expect(tracker.additionalContext("thread-1")).toBeUndefined()
  })

  it("renders reminders when app-server omits the model context window", () => {
    expect(renderContextWindowReminder({
      total: {
        totalTokens: 10,
        inputTokens: 8,
        cachedInputTokens: 0,
        outputTokens: 2,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 10,
        inputTokens: 8,
        cachedInputTokens: 0,
        outputTokens: 2,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: null,
    })).toContain("model context window was not reported")
  })
})

function toolText(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result)) {
    throw new Error("MCP tool result missing content")
  }
  const content = result.content
  if (!Array.isArray(content)) throw new Error("MCP tool result content is not an array")
  const text = content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string")
    .map(part => part.text)
    .join("\n")
  if (text.length === 0) throw new Error("MCP tool result has no text")
  return text
}

function toolJson(result: unknown): Record<string, unknown> {
  const parsed = JSON.parse(toolText(result))
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MCP tool result is not a JSON object")
  }
  return parsed as Record<string, unknown>
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected record")
  return value as Record<string, unknown>
}

function requireStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) throw new Error("expected string array")
  return value
}

function cliJson(run_dir: string, ...args: string[]): Record<string, unknown> {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", join(ROOT, "src", "controller-cli.ts"), "--run-dir", run_dir, "--session-id", "cli-test", ...args],
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!result.success) {
    throw new Error(`controller CLI failed: ${new TextDecoder().decode(result.stderr)}`)
  }
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout))
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("controller CLI did not return a JSON object")
  }
  return parsed as Record<string, unknown>
}

function cliText(run_dir: string, input: string): string {
  const result = spawnSync("bun", [
    "run",
    join(ROOT, "src", "controller-cli.ts"),
    "--run-dir",
    run_dir,
    "--session-id",
    "cli-interactive-test",
    "interactive",
  ], {
    input,
    encoding: "utf8",
    timeout: 30000,
  })
  if (result.status !== 0) throw new Error(`interactive controller CLI failed: ${result.stderr}`)
  return result.stdout
}

function agentJson(...args: string[]): Record<string, unknown> {
  const result = agentRaw(...args)
  if (result.status !== 0) throw new Error(`agent wrapper failed: ${result.stderr}`)
  return requireRecord(JSON.parse(result.stdout))
}

function agentJsonWithEnv(env: Record<string, string>, ...args: string[]): Record<string, unknown> {
  const result = agentRawWithEnv(env, ...args)
  if (result.status !== 0) throw new Error(`agent wrapper failed: ${result.stderr}`)
  return requireRecord(JSON.parse(result.stdout))
}

function agentText(args: string[], input: string): string {
  const result = spawnSync("bun", ["run", join(ROOT, "src", "agent-cli.ts"), ...args], {
    encoding: "utf8",
    input,
    timeout: 30000,
  })
  if (result.status !== 0) throw new Error(`agent wrapper failed: ${result.stderr}`)
  return result.stdout
}

function agentRaw(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  return agentRawWithEnv({}, ...args)
}

function agentRawWithEnv(env: Record<string, string>, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bun", ["run", join(ROOT, "src", "agent-cli.ts"), ...args], {
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, ...env },
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

function turnReportFixture(input_tokens: number, model_visible_context_path: string): Record<string, unknown> {
  return {
    ok: true,
    assistant: "ok",
    thread_id: "thread",
    visible_context_chars: 10,
    model_visible_context_path,
    turn_report_path: `${model_visible_context_path}.json`,
    future_model_visible_context_path: model_visible_context_path,
    n_items_injected: 1,
    n_tool_calls: 0,
    token_usage: {
      last: {
        inputTokens: input_tokens,
        totalTokens: input_tokens + 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
      },
    },
    future_state_persisted: true,
    last_turn_context_path: model_visible_context_path,
  }
}

function managerDryRun(root: string, task_file: string, worker_defaults: string, run_root: string): Record<string, unknown> {
  const result = spawnSync("bun", [
    "run",
    join(ROOT, "src", "manager-agent-launch.ts"),
    "--dry-run",
    "--root",
    root,
    "--task-file",
    task_file,
    "--tmux-session",
    "opc",
    "--workdir",
    root,
    "--worker-defaults",
    worker_defaults,
    "--run-root",
    run_root,
  ], {
    encoding: "utf8",
    timeout: 30000,
  })
  if (result.status !== 0) throw new Error(`manager launcher dry run failed: ${result.stderr}`)
  const parsed = JSON.parse(result.stdout)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("manager launcher did not return a JSON object")
  }
  return parsed as Record<string, unknown>
}

function expectReceiptHidesVisibleContext(text: string): void {
  expect(text).not.toContain("rendered_visible_context")
  expect(text).not.toContain("<system>")
  expect(text).not.toContain("<message")
  expect(text).not.toContain("<compacted")
}

function observeTokenUsage(
  tracker: ContextWindowReminderTracker,
  input_tokens: number,
  model_context_window: number | null = 100000,
) {
  return tracker.observe("thread/tokenUsage/updated", {
    threadId: "thread-1",
    turnId: `turn-${input_tokens}`,
    tokenUsage: {
      total: {
        totalTokens: input_tokens + 100,
        inputTokens: input_tokens,
        cachedInputTokens: 0,
        outputTokens: 100,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: input_tokens + 100,
        inputTokens: input_tokens,
        cachedInputTokens: 0,
        outputTokens: 100,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: model_context_window,
    },
  })
}
