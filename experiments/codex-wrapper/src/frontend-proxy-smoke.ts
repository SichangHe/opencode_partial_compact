#!/usr/bin/env bun
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { startPcodxFrontendProxy, FRONTEND_ACCEPTANCE_SCOPE } from "./frontend-proxy.js"
import { WrapperLedger } from "./ledger.js"

type RequestId = string | number

type JsonRpcMessage = {
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: unknown
}

type FakeUpstream = {
  url: string
  stop(): void
  event_log: string[]
  thread_start_params: unknown[]
  turn_start_params: unknown[]
  turn_start_receipt_seen: boolean[]
  turn_start_reminder_seen: boolean[]
  injected_contexts: string[]
  review_start_params: unknown[]
  native_compact_start_params: unknown[]
  resume_params: unknown[]
  fork_params: unknown[]
  pcodx_tool_responses: unknown[]
}

type JsonRpcClient = {
  request(method: string, params: unknown): Promise<unknown>
  notify(method: string, params: unknown): void
  close(): void
  notifications: JsonRpcMessage[]
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const RUN_DIR = resolve(process.env.PCODX_FRONTEND_PROXY_SMOKE_RUN_DIR ?? join(ROOT, "runs", "frontend-proxy-smoke"))
const SESSION_ID = "frontend-proxy-smoke"
const RAW_A = "PCODX_FRONTEND_PROXY_RAW_SENTINEL_A ".repeat(600)
const RAW_B = "PCODX_FRONTEND_PROXY_RAW_SENTINEL_B ".repeat(600)
const SUMMARY = "frontend proxy compacted both raw sentinel blocks into this durable summary"
const NATIVE_OUTPUT = "NATIVE_COMMAND_OUTPUT_SURVIVES_FRONTEND_PROXY_COMPACTION"

await rm(RUN_DIR, { recursive: true, force: true })
await mkdir(RUN_DIR, { recursive: true })
const ledger = new WrapperLedger(SESSION_ID)
const first = ledger.append("tool", RAW_A, "smoke")
const second = ledger.append("tool", RAW_B, "smoke")
await writeFile(join(RUN_DIR, "ledger.json"), `${JSON.stringify(ledger.snapshot(), null, 2)}\n`, "utf8")

const upstream = startFakeUpstream({
  from_message_id: first.id,
  to_message_id: second.id,
  summary: SUMMARY,
})
const proxy = await startPcodxFrontendProxy({
  upstream_url: upstream.url,
  run_dir: RUN_DIR,
  session_id: SESSION_ID,
  cwd: ROOT,
})
const client = await connectJsonRpc(proxy.url)

try {
  await client.request("initialize", {
    clientInfo: { name: "pcodx-frontend-smoke", title: "PCODX Frontend Smoke", version: "0" },
    capabilities: { experimentalApi: true },
  })
  client.notify("initialized", {})
  const start_result = await client.request("thread/start", {
    cwd: ROOT,
    developerInstructions: "frontend smoke developer instructions",
  })
  const client_thread_id = parseThreadId(start_result)
  const secondary_start_result = await client.request("thread/start", {
    cwd: ROOT,
    developerInstructions: "secondary frontend smoke instructions",
  })
  const secondary_thread_id = parseThreadId(secondary_start_result)
  const review_result = await client.request("review/start", {
    threadId: client_thread_id,
    target: { type: "uncommitted_changes" },
  })
  const compact_result = await client.request("thread/compact/start", { threadId: client_thread_id })
  await client.request("turn/start", {
    threadId: client_thread_id,
    input: [{ type: "text", text: "Run an ordinary native command item before compaction.", text_elements: [] }],
  })
  await client.request("turn/start", {
    threadId: secondary_thread_id,
    input: [{ type: "text", text: "Secondary thread before compaction.", text_elements: [] }],
  })
  await client.request("turn/start", {
    threadId: client_thread_id,
    input: [{ type: "text", text: "Trigger PCODX partial compaction.", text_elements: [] }],
  })
  const inline_review_after_compaction_result = await client.request("review/start", {
    threadId: client_thread_id,
    target: { type: "uncommitted_changes" },
  })
  const inline_review_after_compaction_thread_id = parseReviewThreadId(inline_review_after_compaction_result) ?? ""
  await client.request("turn/start", {
    threadId: client_thread_id,
    input: [{ type: "text", text: "Parent turn immediately after inline review.", text_elements: [] }],
  })
  const detached_review_result = await client.request("review/start", {
    threadId: client_thread_id,
    target: { type: "uncommitted_changes" },
    delivery: "detached",
  })
  const detached_review_thread_id = parseReviewThreadId(detached_review_result) ?? ""
  await client.request("turn/start", {
    threadId: detached_review_thread_id,
    input: [{ type: "text", text: "Continue detached review thread through the proxy.", text_elements: [] }],
  })
  await client.request("turn/start", {
    threadId: client_thread_id,
    input: [{ type: "text", text: "Continue after compaction.", text_elements: [] }],
  })
  await client.request("turn/start", {
    threadId: secondary_thread_id,
    input: [{ type: "text", text: "Secondary thread after compaction.", text_elements: [] }],
  })
  const resume_result = await client.request("thread/resume", {
    threadId: "historic-thread",
    cwd: ROOT,
    developerInstructions: "resumed thread instructions",
  })
  const resumed_thread_id = parseThreadId(resume_result)
  await client.request("turn/start", {
    threadId: resumed_thread_id,
    input: [{ type: "text", text: "Continue a resumed thread through the proxy.", text_elements: [] }],
  })
  const fork_result = await client.request("thread/fork", {
    threadId: resumed_thread_id,
    cwd: ROOT,
    developerInstructions: "forked thread instructions",
  })
  const forked_thread_id = parseThreadId(fork_result)
  await client.request("turn/start", {
    threadId: forked_thread_id,
    input: [{ type: "text", text: "Continue a forked thread through the proxy.", text_elements: [] }],
  })

  const first_context = upstream.injected_contexts.find(context => context.includes("PCODX_FRONTEND_PROXY_RAW_SENTINEL_A")) ?? ""
  const compacted_contexts = upstream.injected_contexts.filter(context => context.includes(SUMMARY))
  const second_context = compacted_contexts[0] ?? ""
  const first_context_path = join(RUN_DIR, "first-injected-context.txt")
  const second_context_path = join(RUN_DIR, "second-injected-context.txt")
  await writeFile(first_context_path, first_context, "utf8")
  await writeFile(second_context_path, second_context, "utf8")
  const review_forwarded = upstream.review_start_params.some(params => isRecord(params) && params.threadId === "upstream-thread-1")
  const native_compact_forwarded = upstream.native_compact_start_params.some(params => isRecord(params) && params.threadId === "upstream-thread-1")
  const dynamic_tools_advertised = upstream.thread_start_params.some(hasPcodxDynamicTools)
  const first_has_raw = first_context.includes("PCODX_FRONTEND_PROXY_RAW_SENTINEL_A") && first_context.includes("PCODX_FRONTEND_PROXY_RAW_SENTINEL_B")
  const second_has_raw = second_context.includes("PCODX_FRONTEND_PROXY_RAW_SENTINEL_A") || second_context.includes("PCODX_FRONTEND_PROXY_RAW_SENTINEL_B")
  const second_has_summary = second_context.includes(SUMMARY)
  const native_output_survived = second_context.includes(NATIVE_OUTPUT)
  const post_turn_ids_injected = upstream.injected_contexts.some(context => context.includes("PCODX turn ledger ids"))
  const trigger_compaction_turn_idx = upstream.turn_start_params.findIndex(params => isRecord(params) && extractTurnPrompt(params).includes("Trigger PCODX partial compaction."))
  const trigger_compaction_saw_prior_receipt = trigger_compaction_turn_idx >= 0 && upstream.turn_start_receipt_seen[trigger_compaction_turn_idx] === true
  const trigger_compaction_saw_context_reminder = trigger_compaction_turn_idx >= 0 && upstream.turn_start_reminder_seen[trigger_compaction_turn_idx] === true
  const pcodx_tool_running_in_client = client.notifications.some(msg =>
    msg.method === "item/completed" &&
    isRecord(msg.params) &&
    isRecord(msg.params.item) &&
    msg.params.item.type === "dynamicToolCall" &&
    msg.params.item.tool === "partial_compact" &&
    msg.params.item.status === "running")
  const pcodx_tool_visible_in_client = client.notifications.some(msg =>
    msg.method === "item/completed" &&
    isRecord(msg.params) &&
    typeof msg.params.completedAtMs === "number" &&
    isRecord(msg.params.item) &&
    msg.params.item.type === "dynamicToolCall" &&
    msg.params.item.tool === "partial_compact" &&
    msg.params.item.namespace === null &&
    Array.isArray(msg.params.item.contentItems) &&
    msg.params.item.status === "completed" &&
    msg.params.item.success === true &&
    typeof msg.params.item.durationMs === "number" &&
    msg.params.item.result === undefined)
  const resume_supported = upstream.resume_params.length === 1 && resumed_thread_id === "upstream-resume-1"
  const fork_supported = upstream.fork_params.length === 1 && forked_thread_id === "upstream-fork-1"
  const resume_dynamic_tools_advertised = upstream.resume_params.some(hasPcodxDynamicTools)
  const fork_dynamic_tools_advertised = upstream.fork_params.some(hasPcodxDynamicTools)
  const detached_review_supported = detached_review_thread_id === "upstream-review-1"
  const inline_review_after_compaction_supported = inline_review_after_compaction_thread_id === client_thread_id
  const parent_turn_after_inline_review_supported = upstream.turn_start_params.some(params =>
    isRecord(params) &&
    params.threadId !== "upstream-thread-1" &&
    extractTurnPrompt(params).includes("Parent turn immediately after inline review"))
  const all_thread_contexts_invalidated = compacted_contexts.length >= 2
  const review_start_refreshed_context = upstream.review_start_params.some(params =>
    isRecord(params) &&
    params.threadId !== "upstream-thread-1" &&
    compacted_contexts.length >= 1)
  const append_only_reconstruction = appendOnlyReconstruction(upstream.event_log)
  const context_insertions_or_mutations = contextInsertionsOrMutations(upstream.event_log)
  const reconstructed_context_appends = reconstructedContextAppends(upstream.event_log)
  const raw_reconstructed_contexts = contextsAfterFirstReconstruction(upstream.injected_contexts).filter(hasRawSentinel)
  const reconstructed_context_appended_to_parent = reconstructed_context_appends.some(event => event.includes("upstream-thread-3"))
  const reconstructed_context_appended_to_secondary = reconstructed_context_appends.some(event => event.includes("upstream-thread-4"))
  const reconstructed_context_appended_to_resume = reconstructed_context_appends.some(event => event.includes("upstream-resume-1"))
  const reconstructed_context_appended_to_fork = reconstructed_context_appends.some(event => event.includes("upstream-fork-1"))
  const reconstructed_context_appended_to_review = reconstructed_context_appends.some(event => event.includes("upstream-review-1"))
  const shrink_chars = first_context.length - second_context.length
  const ok = review_forwarded &&
    native_compact_forwarded &&
    dynamic_tools_advertised &&
    first_has_raw &&
    !second_has_raw &&
    second_has_summary &&
    native_output_survived &&
    !post_turn_ids_injected &&
    !trigger_compaction_saw_prior_receipt &&
    trigger_compaction_saw_context_reminder &&
    pcodx_tool_running_in_client &&
    pcodx_tool_visible_in_client &&
    resume_supported &&
    fork_supported &&
    resume_dynamic_tools_advertised &&
    fork_dynamic_tools_advertised &&
    detached_review_supported &&
    inline_review_after_compaction_supported &&
    parent_turn_after_inline_review_supported &&
    all_thread_contexts_invalidated &&
    review_start_refreshed_context &&
    append_only_reconstruction &&
    raw_reconstructed_contexts.length === 0 &&
    reconstructed_context_appended_to_parent &&
    reconstructed_context_appended_to_secondary &&
    reconstructed_context_appended_to_resume &&
    reconstructed_context_appended_to_fork &&
    reconstructed_context_appended_to_review &&
    upstream.thread_start_params.length >= 2 &&
    shrink_chars > 0 &&
    parseReviewThreadId(review_result) === client_thread_id &&
    isRecord(compact_result)
  const report = {
    ok,
    acceptance_scope: FRONTEND_ACCEPTANCE_SCOPE,
    run_dir: RUN_DIR,
    review_start_forwarded: review_forwarded,
    native_compact_start_forwarded: native_compact_forwarded,
    dynamic_tools_advertised,
    client_thread_id,
    upstream_thread_starts: upstream.thread_start_params.length,
    first_injected_context_chars: first_context.length,
    second_injected_context_chars: second_context.length,
    shrink_chars,
    raw_sentinel_in_first_context: first_has_raw,
    raw_sentinel_in_second_context: second_has_raw,
    summary_in_second_context: second_has_summary,
    native_output_survived,
    post_turn_ids_injected,
    trigger_compaction_saw_prior_receipt,
    trigger_compaction_saw_context_reminder,
    pcodx_tool_running_in_client,
    pcodx_tool_visible_in_client,
    resume_supported,
    fork_supported,
    resume_dynamic_tools_advertised,
    fork_dynamic_tools_advertised,
    detached_review_supported,
    inline_review_after_compaction_supported,
    parent_turn_after_inline_review_supported,
    all_thread_contexts_invalidated,
    review_start_refreshed_context,
    pcodx_tool_response_count: upstream.pcodx_tool_responses.length,
    append_only_reconstruction,
    context_insertions_or_mutations,
    reconstructed_context_appends,
    raw_reconstructed_context_count: raw_reconstructed_contexts.length,
    reconstructed_context_appended_to_parent,
    reconstructed_context_appended_to_secondary,
    reconstructed_context_appended_to_resume,
    reconstructed_context_appended_to_fork,
    reconstructed_context_appended_to_review,
    first_injected_context_path: first_context_path,
    second_injected_context_path: second_context_path,
    transcript_path: join(RUN_DIR, "conversation-transcript.txt"),
  }
  await writeFile(report.transcript_path, renderTranscript(upstream.event_log, report), "utf8")
  await writeFile(join(RUN_DIR, "result.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8")
  console.log(JSON.stringify(report, null, 2))
  if (!ok) process.exitCode = 1
} finally {
  client.close()
  proxy.stop()
  upstream.stop()
}

function startFakeUpstream(compaction: { from_message_id: string; to_message_id: string; summary: string }): FakeUpstream {
  let next_thread_n = 1
  let next_server_request_n = 1
  let next_turn_n = 1
  const thread_start_params: unknown[] = []
  const turn_start_params: unknown[] = []
  const turn_start_receipt_seen: boolean[] = []
  const turn_start_reminder_seen: boolean[] = []
  const injected_contexts: string[] = []
  const review_start_params: unknown[] = []
  const native_compact_start_params: unknown[] = []
  const resume_params: unknown[] = []
  const fork_params: unknown[] = []
  const pcodx_tool_responses: unknown[] = []
  const event_log: string[] = []
  const pending_tool_turns = new Map<RequestId, { request: JsonRpcMessage; thread_id: string }>()
  const thread_start_params_by_id = new Map<string, unknown>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return
      return new Response("fake app-server websocket only\n", { status: 426 })
    },
    websocket: {
      message(ws, data) {
        const msg = parseJsonRpcMessage(data)
        if (isResponse(msg)) {
          const pending = pending_tool_turns.get(msg.id)
          if (!pending) return
          pending_tool_turns.delete(msg.id)
          pcodx_tool_responses.push(msg.result)
          sendTurnComplete(ws, pending.request, pending.thread_id, next_turn_n)
          next_turn_n += 1
          return
        }
        if (!isRequest(msg)) return
        const params = isRecord(msg.params) ? msg.params : {}
        switch (msg.method) {
          case "initialize":
            ws.send(JSON.stringify({ id: msg.id, result: { userAgent: "fake-codex/0", codexHome: tmpdir(), platformFamily: "unix", platformOs: "linux" } }))
            return
          case "thread/start": {
            const thread_id = `upstream-thread-${next_thread_n}`
            next_thread_n += 1
            event_log.push(`thread/start ${thread_id}`)
            thread_start_params.push(msg.params)
            thread_start_params_by_id.set(thread_id, msg.params)
            ws.send(JSON.stringify({ method: "thread/started", params: { thread: { id: thread_id } } }))
            ws.send(JSON.stringify({ id: msg.id, result: { thread: { id: thread_id } } }))
            return
          }
          case "thread/resume":
            event_log.push("thread/resume upstream-resume-1")
            resume_params.push(msg.params)
            ws.send(JSON.stringify({ id: msg.id, result: threadLifecycleResponse("upstream-resume-1") }))
            return
          case "thread/fork":
            event_log.push("thread/fork upstream-fork-1")
            fork_params.push(msg.params)
            ws.send(JSON.stringify({ id: msg.id, result: threadLifecycleResponse("upstream-fork-1") }))
            return
          case "thread/inject_items":
            event_log.push(`thread/inject_items ${String(params.threadId ?? "missing-thread")} ${classifyInjectedContext(extractInjectedContext(params))}`)
            injected_contexts.push(extractInjectedContext(params))
            ws.send(JSON.stringify({ id: msg.id, result: {} }))
            return
          case "review/start":
            event_log.push(`review/start ${String(params.threadId ?? "missing-thread")}`)
            review_start_params.push(msg.params)
            if (params.delivery === "detached") {
              event_log.push("review/thread upstream-review-1")
              ws.send(JSON.stringify({ id: msg.id, result: { reviewThreadId: "upstream-review-1", turn: { id: "review-turn", status: "completed" } } }))
            } else {
              ws.send(JSON.stringify({ id: msg.id, result: { reviewThreadId: params.threadId, turn: { id: "review-turn", status: "completed" } } }))
            }
            return
          case "thread/compact/start":
            event_log.push(`thread/compact/start ${String(params.threadId ?? "missing-thread")}`)
            native_compact_start_params.push(msg.params)
            ws.send(JSON.stringify({ id: msg.id, result: {} }))
            return
          case "turn/start": {
            event_log.push(`turn/start ${String(params.threadId ?? "missing-thread")} ${extractTurnPrompt(params)}`)
            turn_start_params.push(msg.params)
            turn_start_receipt_seen.push(injected_contexts.some(context => context.includes("PCODX turn ledger ids")))
            turn_start_reminder_seen.push(hasContextReminder(params))
            const thread_id = typeof params.threadId === "string" ? params.threadId : "missing-thread"
            const prompt = extractTurnPrompt(params)
            if (prompt.includes("Run an ordinary native command item")) {
              sendNativeCommandItem(ws, thread_id)
              sendTurnComplete(ws, msg, thread_id, next_turn_n)
              next_turn_n += 1
              return
            }
            if (prompt.includes("Trigger PCODX") && hasPcodxDynamicTools(thread_start_params_by_id.get(thread_id))) {
              const tool_request_id = `tool-${next_server_request_n}`
              next_server_request_n += 1
              pending_tool_turns.set(tool_request_id, { request: msg, thread_id })
              ws.send(JSON.stringify({
                id: tool_request_id,
                method: "item/tool/call",
                params: {
                  threadId: thread_id,
                  turnId: "turn-1",
                  callId: "call-1",
                  namespace: null,
                  tool: "partial_compact",
                  arguments: {
                    ranges: [{
                      from_message_id: compaction.from_message_id,
                      to_message_id: compaction.to_message_id,
                      summary: compaction.summary,
                    }],
                  },
                },
              }))
              return
            }
            sendTurnComplete(ws, msg, thread_id, next_turn_n)
            next_turn_n += 1
            return
          }
          default:
            ws.send(JSON.stringify({ id: msg.id, result: {} }))
        }
      },
    },
  })
  return {
    url: `ws://127.0.0.1:${server.port}`,
    stop() {
      server.stop(true)
    },
    event_log,
    thread_start_params,
    turn_start_params,
    turn_start_receipt_seen,
    turn_start_reminder_seen,
    injected_contexts,
    review_start_params,
    native_compact_start_params,
    resume_params,
    fork_params,
    pcodx_tool_responses,
  }
}

function threadLifecycleResponse(thread_id: string): Record<string, unknown> {
  return {
    thread: {
      id: thread_id,
      cwd: ROOT,
      turns: [],
    },
    model: "gpt-test",
    modelProvider: "openai",
    serviceTier: null,
    cwd: ROOT,
    runtimeWorkspaceRoots: [ROOT],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { mode: "danger-full-access" },
    activePermissionProfile: null,
    reasoningEffort: null,
  }
}

function sendNativeCommandItem(ws: { send(data: string): void }, thread_id: string): void {
  ws.send(JSON.stringify({
    method: "item/completed",
    params: {
      threadId: thread_id,
      turnId: "turn-ordinary-native",
      completedAtMs: 0,
      item: {
        type: "commandExecution",
        id: "cmd-1",
        command: "printf native-output",
        cwd: ROOT,
        processId: null,
        source: "exec",
        status: "completed",
        commandActions: [],
        aggregatedOutput: NATIVE_OUTPUT,
        exitCode: 0,
        durationMs: 1,
      },
    },
  }))
}

function sendTurnComplete(ws: { send(data: string): void }, request: JsonRpcMessage, thread_id: string, turn_n: number): void {
  ws.send(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: thread_id, delta: `assistant turn ${turn_n}` } }))
  ws.send(JSON.stringify({ method: "turn/completed", params: { threadId: thread_id, turn: { id: `turn-${turn_n}`, status: "completed" } } }))
  ws.send(JSON.stringify({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: thread_id,
      turnId: `turn-${turn_n}`,
      tokenUsage: {
        total: tokenUsageBreakdown(16_000 * turn_n),
        last: tokenUsageBreakdown(16_000 * turn_n),
        modelContextWindow: 100_000,
      },
    },
  }))
  ws.send(JSON.stringify({ id: request.id, result: { turn: { id: `turn-${turn_n}`, status: "completed" } } }))
}

function tokenUsageBreakdown(input_tokens: number): Record<string, number> {
  return {
    totalTokens: input_tokens + 100,
    inputTokens: input_tokens,
    cachedInputTokens: 0,
    outputTokens: 100,
    reasoningOutputTokens: 0,
  }
}

function hasContextReminder(params: Record<string, unknown>): boolean {
  const additional_context = params.additionalContext
  return isRecord(additional_context) && isRecord(additional_context["pcodx.context_window_reminder"])
}

function hasPcodxDynamicTools(params: unknown): boolean {
  if (!isRecord(params) || !Array.isArray(params.dynamicTools)) return false
  const names = params.dynamicTools.flatMap(tool => isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [])
  return names.includes("partial_compact") && names.includes("partial_compact_current_session_message_ids")
}

async function connectJsonRpc(url: string): Promise<JsonRpcClient> {
  const ws = new WebSocket(url)
  let next_id = 1
  const pending = new Map<RequestId, { resolve: (value: unknown) => void; reject: (err: Error) => void; method: string }>()
  const notifications: JsonRpcMessage[] = []
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out connecting to ${url}`)), 10000)
    ws.addEventListener("open", () => {
      clearTimeout(timer)
      resolvePromise()
    }, { once: true })
    ws.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error(`failed connecting to ${url}`))
    }, { once: true })
  })
  ws.addEventListener("message", event => {
    const msg = parseJsonRpcMessage(event.data)
    if (isRequest(msg)) {
      ws.send(JSON.stringify({ id: msg.id, result: { decision: "decline" } }))
      return
    }
    if (isNotification(msg)) {
      notifications.push(msg)
      return
    }
    if (!isResponse(msg)) return
    const item = pending.get(msg.id)
    if (!item) return
    pending.delete(msg.id)
    if (msg.error === undefined) item.resolve(msg.result)
    else item.reject(new Error(`${item.method}: ${JSON.stringify(msg.error)}`))
  })
  return {
    request(method: string, params: unknown): Promise<unknown> {
      const id = next_id
      next_id += 1
      ws.send(JSON.stringify({ id, method, params }))
      return new Promise((resolvePromise, reject) => {
        pending.set(id, { resolve: resolvePromise, reject, method })
      })
    },
    notify(method: string, params: unknown): void {
      ws.send(JSON.stringify({ method, params }))
    },
    close(): void {
      ws.close()
    },
    notifications,
  }
}

function extractInjectedContext(params: Record<string, unknown>): string {
  const items = params.items
  if (!Array.isArray(items)) return ""
  return items.flatMap(item => {
    if (!isRecord(item) || !Array.isArray(item.content)) return []
    return item.content.flatMap(part => isRecord(part) && typeof part.text === "string" ? [part.text] : [])
  }).join("\n")
}

function classifyInjectedContext(context: string): string {
  if (context.includes(SUMMARY) && hasRawSentinel(context)) return "mutated-compacted-ledger-render"
  if (context.includes(SUMMARY)) return "compacted-ledger-render"
  if (hasRawSentinel(context)) return "raw-ledger-render"
  return "unknown-context"
}

function hasRawSentinel(context: string): boolean {
  return context.includes("PCODX_FRONTEND_PROXY_RAW_SENTINEL_A") || context.includes("PCODX_FRONTEND_PROXY_RAW_SENTINEL_B")
}

function contextsAfterFirstReconstruction(contexts: string[]): string[] {
  const first_idx = contexts.findIndex(context => context.includes(SUMMARY))
  return first_idx === -1 ? [] : contexts.slice(first_idx)
}

function appendOnlyReconstruction(event_log: string[]): boolean {
  return contextInsertionsOrMutations(event_log).length === 0
}

function contextInsertionsOrMutations(event_log: string[]): string[] {
  const started_threads = new Set<string>()
  const threads_with_turns = new Set<string>()
  const violations: string[] = []
  for (const event of event_log) {
    const thread_id = eventThreadId(event)
    if (!thread_id) continue
    if (isThreadLifecycleEvent(event)) started_threads.add(thread_id)
    if (event.startsWith("thread/inject_items ")) {
      if (!started_threads.has(thread_id) || threads_with_turns.has(thread_id)) violations.push(event)
    }
    if (event.startsWith("turn/start ")) threads_with_turns.add(thread_id)
  }
  return violations
}

function reconstructedContextAppends(event_log: string[]): string[] {
  return event_log.filter(event => event.startsWith("thread/inject_items ") && event.includes("compacted-ledger-render"))
}

function eventThreadId(event: string): string | null {
  const parts = event.split(" ")
  if (
    event.startsWith("thread/start ") ||
    event.startsWith("thread/resume ") ||
    event.startsWith("thread/fork ") ||
    event.startsWith("review/start ") ||
    event.startsWith("review/thread ") ||
    event.startsWith("thread/inject_items ") ||
    event.startsWith("turn/start ")
  ) return parts[1] ?? null
  return null
}

function isThreadLifecycleEvent(event: string): boolean {
  return event.startsWith("thread/start ") ||
    event.startsWith("thread/resume ") ||
    event.startsWith("thread/fork ") ||
    event.startsWith("review/start ") ||
    event.startsWith("review/thread ")
}

function renderTranscript(event_log: string[], report: Record<string, unknown>): string {
  return [
    "pcodx frontend proxy append-only resume demonstration",
    "",
    "conversation-shaped upstream transcript:",
    ...event_log.map((event, idx) => `${idx + 1}. ${event}`),
    "",
    `append_only_reconstruction=${String(report.append_only_reconstruction)}`,
    `context_insertions_or_mutations=${JSON.stringify(report.context_insertions_or_mutations)}`,
    `reconstructed_context_appends=${JSON.stringify(report.reconstructed_context_appends)}`,
    `raw_reconstructed_context_count=${String(report.raw_reconstructed_context_count)}`,
    `reconstructed_context_appended_to_parent=${String(report.reconstructed_context_appended_to_parent)}`,
    `reconstructed_context_appended_to_secondary=${String(report.reconstructed_context_appended_to_secondary)}`,
    `reconstructed_context_appended_to_resume=${String(report.reconstructed_context_appended_to_resume)}`,
    `reconstructed_context_appended_to_fork=${String(report.reconstructed_context_appended_to_fork)}`,
    `reconstructed_context_appended_to_review=${String(report.reconstructed_context_appended_to_review)}`,
    `raw_sentinel_in_first_context=${String(report.raw_sentinel_in_first_context)}`,
    `raw_sentinel_in_second_context=${String(report.raw_sentinel_in_second_context)}`,
    `summary_in_second_context=${String(report.summary_in_second_context)}`,
    `resume_supported=${String(report.resume_supported)}`,
    `fork_supported=${String(report.fork_supported)}`,
    "",
  ].join("\n")
}

function extractTurnPrompt(params: Record<string, unknown>): string {
  const input = params.input
  if (!Array.isArray(input)) return ""
  return input.flatMap(item => isRecord(item) && typeof item.text === "string" ? [item.text] : []).join("\n")
}

function parseThreadId(result: unknown): string {
  if (isRecord(result) && isRecord(result.thread) && typeof result.thread.id === "string") return result.thread.id
  throw new Error("thread/start response omitted thread.id")
}

function parseReviewThreadId(result: unknown): string | null {
  return isRecord(result) && typeof result.reviewThreadId === "string" ? result.reviewThreadId : null
}

function parseJsonRpcMessage(data: unknown): JsonRpcMessage {
  const text = typeof data === "string" ? data : Buffer.from(data as Buffer).toString("utf8")
  const parsed = JSON.parse(text)
  if (!isRecord(parsed)) throw new Error("JSON-RPC message must be an object")
  return parsed
}

function isRequest(msg: JsonRpcMessage): msg is { id: RequestId; method: string; params: unknown } {
  return isRequestId(msg.id) && typeof msg.method === "string"
}

function isResponse(msg: JsonRpcMessage): msg is { id: RequestId; result?: unknown; error?: unknown } {
  return isRequestId(msg.id) && typeof msg.method !== "string"
}

function isNotification(msg: JsonRpcMessage): msg is { method: string; params: unknown } {
  return !isRequestId(msg.id) && typeof msg.method === "string"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number"
}
