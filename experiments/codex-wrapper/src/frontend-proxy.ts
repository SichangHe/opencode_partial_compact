import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { WrapperLedger } from "./ledger.js"
import type { PartialCompactRange } from "./types.js"

type RequestId = string | number

type JsonRpcMessage = {
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: unknown
}

type ClientSocket = {
  send(data: string): void
  close(code?: number, reason?: string): void
}

type PendingClientRequest = {
  client_id: RequestId
  method: string
  params: unknown
  original_params: unknown
}

type PendingServerRequest = {
  upstream_id: RequestId
  method: string
}

type PendingInternalRequest = {
  method: string
  resolve: (result: unknown) => void
  reject: (err: Error) => void
}

type TurnState = {
  user_text: string
  assistant_text: string
  tool_transcripts: string[]
  completed_item_transcripts: string[]
  compacted: boolean
}

type ThreadState = {
  client_thread_id: string
  upstream_thread_id: string
  start_params: Record<string, unknown>
  context_injected_upstream_id: string | null
  needs_fresh_upstream: boolean
  current_turn: TurnState | null
}

type LedgerState = {
  run_dir: string
  ledger_path: string
  visible_context_path: string
  ledger: WrapperLedger
}

export type PcodxFrontendProxyOptions = {
  upstream_url: string
  run_dir: string
  session_id: string
  cwd?: string
  host?: string
  port?: number
}

export type PcodxFrontendProxyServer = {
  url: string
  port: number
  stop(): void
}

export const FRONTEND_ACCEPTANCE_SCOPE = "codex front-end remote app-server proxy"
export const FRONTEND_ACCEPTANCE_SCOPE_TEXT = `acceptance_scope=${FRONTEND_ACCEPTANCE_SCOPE}`

const PCODX_DEVELOPER_INSTRUCTIONS = [
  "PCODX partial compaction is available in this Codex front-end session through dynamic tools.",
  "Use `partial_compact_current_session_message_ids` to inspect compactable `msg...` ids.",
  "Use `partial_compact` to replace stale ledger ranges with faithful summaries.",
  "After a successful PCODX compaction, the proxy starts the next upstream app-server turn from a fresh thread seeded only with the compacted ledger render.",
].join("\n")

const PCODX_DYNAMIC_TOOLS = [
  {
    name: "partial_compact_current_session_message_ids",
    description: "Return the currently visible PCODX ledger ids after front-end proxy compactions.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "partial_compact",
    description: "Replace one or more disjoint ranges of prior PCODX ledger messages with faithful summaries for future Codex front-end turns.",
    inputSchema: {
      type: "object",
      properties: {
        ranges: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              from_message_id: { type: "string" },
              to_message_id: { type: "string" },
              summary: { type: "string" },
            },
            required: ["from_message_id", "to_message_id", "summary"],
            additionalProperties: false,
          },
        },
      },
      required: ["ranges"],
      additionalProperties: false,
    },
  },
]

export async function startPcodxFrontendProxy(options: PcodxFrontendProxyOptions): Promise<PcodxFrontendProxyServer> {
  const host = options.host ?? "127.0.0.1"
  const ledger_state = await loadLedgerState(options)
  const connections = new WeakMap<ClientSocket, FrontendProxyConnection>()
  const server = Bun.serve({
    hostname: host,
    port: options.port ?? 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return
      return new Response("PCODX Codex front-end proxy expects a websocket connection.\n", { status: 426 })
    },
    websocket: {
      open(ws) {
        connections.set(ws, new FrontendProxyConnection(ws, options.upstream_url, ledger_state, options.cwd))
      },
      message(ws, message) {
        void connections.get(ws)?.handleClientMessage(message).catch(err => ws.close(1011, messageText(err)))
      },
      close(ws) {
        connections.get(ws)?.close()
      },
    },
  })
  if (server.port === undefined) throw new Error("PCODX frontend proxy did not receive a listen port")
  return {
    url: `ws://${host}:${server.port}`,
    port: server.port,
    stop() {
      server.stop(true)
    },
  }
}

class FrontendProxyConnection {
  readonly #client: ClientSocket
  readonly #ledger_state: LedgerState
  readonly #cwd: string | undefined
  readonly #upstream: WebSocket
  readonly #upstream_ready: Promise<void>
  #next_id = 1
  readonly #pending_client_requests = new Map<RequestId, PendingClientRequest>()
  readonly #pending_server_requests = new Map<RequestId, PendingServerRequest>()
  readonly #pending_internal_requests = new Map<RequestId, PendingInternalRequest>()
  readonly #threads_by_client_id = new Map<string, ThreadState>()
  readonly #threads_by_upstream_id = new Map<string, ThreadState>()
  #n_internal_thread_starts_pending = 0

  constructor(client: ClientSocket, upstream_url: string, ledger_state: LedgerState, cwd: string | undefined) {
    this.#client = client
    this.#ledger_state = ledger_state
    this.#cwd = cwd
    this.#upstream = new WebSocket(upstream_url)
    this.#upstream_ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out connecting to upstream ${upstream_url}`)), 10000)
      this.#upstream.addEventListener("open", () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
      this.#upstream.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error(`failed connecting to upstream ${upstream_url}`))
      }, { once: true })
    })
    this.#upstream.addEventListener("message", event => {
      void this.#handleUpstreamMessage(event.data).catch(err => this.#client.close(1011, messageText(err)))
    })
    this.#upstream.addEventListener("close", () => {
      this.#rejectInternalRequests(new Error("upstream app-server connection closed"))
      this.#client.close()
    })
  }

  close(): void {
    this.#upstream.close()
  }

  async handleClientMessage(data: string | Buffer): Promise<void> {
    const msg = parseJsonRpcMessage(data)
    if (isResponse(msg)) {
      const pending = this.#pending_server_requests.get(msg.id)
      if (!pending) return
      this.#pending_server_requests.delete(msg.id)
      this.#sendUpstream({
        id: pending.upstream_id,
        ...(msg.error === undefined ? { result: msg.result } : { error: msg.error }),
      })
      return
    }
    if (!isRequest(msg)) {
      this.#sendUpstream(msg)
      return
    }
    await this.#handleClientRequest(msg)
  }

  async #handleClientRequest(msg: { id: RequestId; method: string; params: unknown }): Promise<void> {
    await this.#upstream_ready
    const request = await this.#prepareClientRequest(msg.method, msg.params)
    const proxy_id = this.#nextRequestId()
    this.#pending_client_requests.set(proxy_id, { client_id: msg.id, method: msg.method, params: request.params, original_params: msg.params })
    if (request.turn_thread) this.#beginTurn(request.turn_thread, request.params)
    this.#sendUpstream({ id: proxy_id, method: msg.method, params: request.params })
  }

  async #prepareClientRequest(method: string, params: unknown): Promise<{ params: unknown; turn_thread?: ThreadState }> {
    if (method === "thread/start") {
      return { params: this.#prepareThreadStartParams(params) }
    }
    if (method === "thread/resume" || method === "thread/fork") {
      const prepared = withPcodxDeveloperInstructions(params, this.#cwd)
      const thread = this.#threadFromParams(prepared)
      return { params: thread ? rewriteThreadIds(prepared, thread.client_thread_id, thread.upstream_thread_id) : prepared }
    }
    if (method === "turn/start") {
      const thread = await this.#prepareTurnStart(params)
      return { params: rewriteThreadIds(params, thread.client_thread_id, thread.upstream_thread_id), turn_thread: thread }
    }
    if (method === "review/start") {
      const thread = await this.#prepareReviewStart(params)
      return { params: rewriteThreadIds(params, thread.client_thread_id, thread.upstream_thread_id) }
    }
    const thread = this.#threadFromParams(params)
    if (!thread) return { params }
    return { params: rewriteThreadIds(params, thread.client_thread_id, thread.upstream_thread_id) }
  }

  #prepareThreadStartParams(params: unknown): Record<string, unknown> {
    return withPcodxThreadStartParams(params, this.#cwd)
  }

  async #prepareTurnStart(params: unknown): Promise<ThreadState> {
    const thread = this.#threadFromParams(params)
    if (!thread) throw new Error("turn/start omitted a known threadId")
    if (thread.needs_fresh_upstream) await this.#startFreshUpstreamThread(thread)
    if (this.#ledger_state.ledger.visibleEntries().length > 0 && thread.context_injected_upstream_id !== thread.upstream_thread_id) {
      await this.#injectCurrentContext(thread)
    }
    return thread
  }

  async #prepareReviewStart(params: unknown): Promise<ThreadState> {
    const thread = this.#threadFromParams(params)
    if (!thread) throw new Error("review/start omitted a known threadId")
    if (thread.needs_fresh_upstream) await this.#startFreshUpstreamThread(thread)
    if (this.#ledger_state.ledger.visibleEntries().length > 0 && thread.context_injected_upstream_id !== thread.upstream_thread_id) {
      await this.#injectCurrentContext(thread)
    }
    return thread
  }

  async #startFreshUpstreamThread(thread: ThreadState): Promise<void> {
    this.#n_internal_thread_starts_pending += 1
    const result = await this.#requestUpstream("thread/start", { ...thread.start_params, ephemeral: true }).finally(() => {
      this.#n_internal_thread_starts_pending -= 1
    })
    const upstream_thread_id = parseThreadId(result, "thread/start")
    this.#threads_by_upstream_id.delete(thread.upstream_thread_id)
    thread.upstream_thread_id = upstream_thread_id
    thread.context_injected_upstream_id = null
    thread.needs_fresh_upstream = false
    thread.current_turn = null
    this.#threads_by_upstream_id.set(upstream_thread_id, thread)
  }

  async #injectCurrentContext(thread: ThreadState): Promise<void> {
    const context = this.#renderVisibleContext()
    await this.#requestUpstream("thread/inject_items", {
      threadId: thread.upstream_thread_id,
      items: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: context }],
      }],
    })
    thread.context_injected_upstream_id = thread.upstream_thread_id
  }

  #beginTurn(thread: ThreadState, rewritten_params: unknown): void {
    thread.current_turn = {
      user_text: extractTurnInputText(rewritten_params),
      assistant_text: "",
      tool_transcripts: [],
      completed_item_transcripts: [],
      compacted: false,
    }
  }

  async #handleUpstreamMessage(data: unknown): Promise<void> {
    const msg = parseJsonRpcMessage(data)
    if (isRequest(msg)) {
      await this.#handleUpstreamRequest(msg)
      return
    }
    if (isResponse(msg)) {
      this.#handleUpstreamResponse(msg)
      return
    }
    if (isNotification(msg)) {
      await this.#handleUpstreamNotification(msg.method, msg.params)
      if (msg.method === "thread/started" && this.#threadFromUpstreamParams(msg.params) === null && this.#n_internal_thread_starts_pending > 0) return
      this.#client.send(JSON.stringify({
        method: msg.method,
        params: this.#rewriteUpstreamThreadIds(msg.params),
      }))
    }
  }

  async #handleUpstreamRequest(msg: { id: RequestId; method: string; params: unknown }): Promise<void> {
    if (msg.method === "item/tool/call" && isPcodxToolCall(msg.params)) {
      const result = await this.#handlePcodxToolCall(msg.params)
      this.#sendUpstream({ id: msg.id, result })
      return
    }
    const proxy_id = this.#nextRequestId()
    this.#pending_server_requests.set(proxy_id, { upstream_id: msg.id, method: msg.method })
    this.#client.send(JSON.stringify({
      id: proxy_id,
      method: msg.method,
      params: this.#rewriteUpstreamThreadIds(msg.params),
    }))
  }

  #handleUpstreamResponse(msg: { id: RequestId; result?: unknown; error?: unknown }): void {
    const internal = this.#pending_internal_requests.get(msg.id)
    if (internal) {
      this.#pending_internal_requests.delete(msg.id)
      if (msg.error === undefined) internal.resolve(msg.result)
      else internal.reject(new Error(`${internal.method}: ${JSON.stringify(msg.error)}`))
      return
    }
    const pending = this.#pending_client_requests.get(msg.id)
    if (!pending) return
    this.#pending_client_requests.delete(msg.id)
    if (isThreadMappingResponse(pending.method) && msg.error === undefined) {
      this.#recordThreadMapping(msg.result, pending)
    }
    if (pending.method === "review/start" && msg.error === undefined) {
      this.#recordReviewThreadMapping(msg.result, pending.original_params)
    }
    this.#client.send(JSON.stringify({
      id: pending.client_id,
      ...(msg.error === undefined ? { result: this.#rewriteUpstreamThreadIds(msg.result) } : { error: msg.error }),
    }))
  }

  #recordThreadMapping(result: unknown, pending: PendingClientRequest): void {
    const upstream_thread_id = parseThreadId(result, pending.method)
    const start_params = pending.method === "thread/start"
      ? isRecord(pending.params) ? pending.params : {}
      : threadStartParamsFromResumedThread(result, pending.params, this.#cwd)
    this.#upsertThreadMapping(upstream_thread_id, upstream_thread_id, start_params)
  }

  #recordReviewThreadMapping(result: unknown, params: unknown): void {
    if (!isRecord(result) || typeof result.reviewThreadId !== "string") return
    if (!isRecord(params) || typeof params.threadId !== "string") return
    const parent = this.#threads_by_client_id.get(params.threadId)
    if (!parent) return
    if (result.reviewThreadId === parent.client_thread_id || result.reviewThreadId === parent.upstream_thread_id) return
    const upstream_review_thread_id = result.reviewThreadId
    this.#upsertThreadMapping(result.reviewThreadId, upstream_review_thread_id, parent.start_params)
  }

  #upsertThreadMapping(client_thread_id: string, upstream_thread_id: string, start_params: Record<string, unknown>): void {
    const existing = this.#threads_by_client_id.get(client_thread_id)
    if (existing) this.#threads_by_upstream_id.delete(existing.upstream_thread_id)
    const thread: ThreadState = {
      client_thread_id,
      upstream_thread_id,
      start_params,
      context_injected_upstream_id: null,
      needs_fresh_upstream: false,
      current_turn: null,
    }
    this.#threads_by_client_id.set(thread.client_thread_id, thread)
    this.#threads_by_upstream_id.set(thread.upstream_thread_id, thread)
  }

  async #handleUpstreamNotification(method: string, params: unknown): Promise<void> {
    const thread = this.#threadFromUpstreamParams(params)
    if (!thread) return
    if (method === "item/agentMessage/delta" && thread.current_turn) {
      const delta = isRecord(params) && typeof params.delta === "string" ? params.delta : ""
      thread.current_turn.assistant_text += delta
      return
    }
    if (method === "item/completed" && thread.current_turn) {
      const transcript = renderCompletedItemTranscript(params)
      if (transcript) thread.current_turn.completed_item_transcripts.push(transcript)
      return
    }
    if (method === "turn/completed" && thread.current_turn) {
      await this.#completeTurn(thread)
    }
  }

  async #completeTurn(thread: ThreadState): Promise<void> {
    const turn = thread.current_turn
    if (!turn) return
    if (turn.compacted) {
      for (const text of turn.tool_transcripts) {
        this.#ledger_state.ledger.append("tool", text, "frontend-proxy:tool")
      }
      this.#ledger_state.ledger.append(
        "assistant",
        "PCODX front-end proxy omitted the current turn prompt and assistant text from future ledger state after compaction so raw pre-compaction context is not reintroduced.",
        "frontend-proxy:post-compact",
      )
    } else {
      if (turn.user_text.trim()) this.#ledger_state.ledger.append("user", turn.user_text, "frontend-proxy:user")
      for (const text of turn.completed_item_transcripts) {
        this.#ledger_state.ledger.append("tool", text, "frontend-proxy:item")
      }
      for (const text of turn.tool_transcripts) {
        this.#ledger_state.ledger.append("tool", text, "frontend-proxy:tool")
      }
      this.#ledger_state.ledger.append("assistant", turn.assistant_text.trim() || "(empty assistant response)", "frontend-proxy:assistant")
    }
    thread.current_turn = null
    await saveLedgerState(this.#ledger_state)
  }

  async #handlePcodxToolCall(params: Record<string, unknown>): Promise<unknown> {
    const thread = typeof params.threadId === "string" ? this.#threads_by_upstream_id.get(params.threadId) : undefined
    const tool = params.tool
    let text: string
    let success = true
    let compacted = false
    if (tool === "partial_compact_current_session_message_ids") {
      text = JSON.stringify({
        ok: true,
        visible_message_ids: compactableMessageIds(this.#ledger_state.ledger),
        visible_entry_ids: this.#ledger_state.ledger.currentVisibleMessageIds(),
        future_model_visible_context_source: FRONTEND_ACCEPTANCE_SCOPE,
      }, null, 2)
    } else if (tool === "partial_compact") {
      try {
        const ranges = parsePartialCompactRanges(params.arguments)
        const result = this.#ledger_state.ledger.partialCompactRanges(ranges)
        success = result.ok
        compacted = result.ok
        if (result.ok && thread) {
          this.#invalidateAllThreads()
          if (thread.current_turn) thread.current_turn.compacted = true
        }
        text = JSON.stringify(compactionReceipt(result, this.#ledger_state.ledger), null, 2)
        await saveLedgerState(this.#ledger_state)
      } catch (err) {
        success = false
        text = JSON.stringify({ ok: false, error: messageText(err) }, null, 2)
      }
    } else {
      success = false
      text = JSON.stringify({ ok: false, error: `unknown PCODX dynamic tool ${String(tool)}` }, null, 2)
    }
    if (thread?.current_turn) thread.current_turn.tool_transcripts.push(`${String(tool)} result: ${text}`)
    return {
      contentItems: [{ type: "inputText", text }],
      success,
      compacted,
    }
  }

  #invalidateAllThreads(): void {
    for (const mapped_thread of this.#threads_by_client_id.values()) {
      mapped_thread.needs_fresh_upstream = true
      mapped_thread.context_injected_upstream_id = null
    }
  }

  #threadFromParams(params: unknown): ThreadState | null {
    const thread_id = isRecord(params) && typeof params.threadId === "string" ? params.threadId : null
    return thread_id ? this.#threads_by_client_id.get(thread_id) ?? null : null
  }

  #threadFromUpstreamParams(params: unknown): ThreadState | null {
    const thread_id = isRecord(params) && typeof params.threadId === "string"
      ? params.threadId
      : isRecord(params) && isRecord(params.thread) && typeof params.thread.id === "string"
        ? params.thread.id
        : null
    return thread_id ? this.#threads_by_upstream_id.get(thread_id) ?? null : null
  }

  #rewriteUpstreamThreadIds(value: unknown): unknown {
    let rewritten = value
    for (const thread of this.#threads_by_client_id.values()) {
      rewritten = rewriteThreadIds(rewritten, thread.upstream_thread_id, thread.client_thread_id)
    }
    return rewritten
  }

  #renderVisibleContext(): string {
    return this.#ledger_state.ledger.renderVisibleContext(PCODX_DEVELOPER_INSTRUCTIONS)
  }

  #requestUpstream(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextRequestId()
    return new Promise((resolve, reject) => {
      this.#pending_internal_requests.set(id, { method, resolve, reject })
      this.#sendUpstream({ id, method, params })
    })
  }

  #nextRequestId(): RequestId {
    const id = `pcodx-${this.#next_id}`
    this.#next_id += 1
    return id
  }

  #sendUpstream(msg: unknown): void {
    this.#upstream.send(JSON.stringify(msg))
  }

  #rejectInternalRequests(err: Error): void {
    for (const pending of this.#pending_internal_requests.values()) {
      pending.reject(err)
    }
    this.#pending_internal_requests.clear()
  }
}

async function loadLedgerState(options: PcodxFrontendProxyOptions): Promise<LedgerState> {
  const run_dir = resolve(options.run_dir)
  const ledger_path = join(run_dir, "ledger.json")
  const visible_context_path = join(run_dir, "model-visible-context.txt")
  let ledger: WrapperLedger
  try {
    ledger = WrapperLedger.fromSnapshot(JSON.parse(await readFile(ledger_path, "utf8")))
  } catch (err) {
    if (!isMissingFileError(err)) throw err
    ledger = new WrapperLedger(options.session_id)
  }
  if (ledger.session_id !== options.session_id) {
    throw new Error(`ledger session_id ${ledger.session_id} does not match frontend proxy session_id ${options.session_id}`)
  }
  const state = { run_dir, ledger_path, visible_context_path, ledger }
  await saveLedgerState(state)
  return state
}

async function saveLedgerState(state: LedgerState): Promise<void> {
  await mkdir(state.run_dir, { recursive: true })
  await writeFile(state.ledger_path, `${JSON.stringify(state.ledger.snapshot(), null, 2)}\n`, "utf8")
  await writeFile(state.visible_context_path, `${state.ledger.renderVisibleContext(PCODX_DEVELOPER_INSTRUCTIONS)}\n`, "utf8")
}

function withPcodxThreadStartParams(params: unknown, cwd: string | undefined): Record<string, unknown> {
  const raw = withPcodxDeveloperInstructions(params, cwd)
  raw.dynamicTools = mergeDynamicTools(raw.dynamicTools, PCODX_DYNAMIC_TOOLS)
  return raw
}

function withPcodxDeveloperInstructions(params: unknown, cwd: string | undefined): Record<string, unknown> {
  const raw = isRecord(params) ? { ...params } : {}
  const existing_developer = typeof raw.developerInstructions === "string" ? raw.developerInstructions.trim() : ""
  raw.developerInstructions = existing_developer.includes(PCODX_DEVELOPER_INSTRUCTIONS)
    ? existing_developer
    : [existing_developer, PCODX_DEVELOPER_INSTRUCTIONS].filter(Boolean).join("\n\n")
  if (cwd !== undefined && raw.cwd === undefined) raw.cwd = cwd
  return raw
}

function threadStartParamsFromResumedThread(result: unknown, original_params: unknown, fallback_cwd: string | undefined): Record<string, unknown> {
  const raw: Record<string, unknown> = {}
  const response = isRecord(result) ? result : {}
  const thread = isRecord(response.thread) ? response.thread : {}
  copyIfPresent(raw, response, "model")
  copyIfPresent(raw, response, "modelProvider")
  copyIfPresent(raw, response, "serviceTier")
  copyIfPresent(raw, response, "cwd")
  copyIfPresent(raw, response, "runtimeWorkspaceRoots")
  copyIfPresent(raw, response, "approvalPolicy")
  copyIfPresent(raw, response, "approvalsReviewer")
  copyIfPresent(raw, thread, "cwd")
  if (isRecord(original_params)) {
    for (const key of ["config", "baseInstructions", "developerInstructions", "personality", "permissions", "sandbox", "ephemeral", "threadSource"]) {
      copyIfPresent(raw, original_params, key)
    }
  }
  return withPcodxThreadStartParams(raw, fallback_cwd)
}

function copyIfPresent(target: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  const value = source[key]
  if (value !== undefined && value !== null) target[key] = value
}

function mergeDynamicTools(existing: unknown, tools: typeof PCODX_DYNAMIC_TOOLS): unknown[] {
  const merged = Array.isArray(existing) ? [...existing] : []
  const names = new Set(merged.flatMap(tool => isRecord(tool) && typeof tool.name === "string" ? [tool.name] : []))
  for (const tool of tools) {
    if (!names.has(tool.name)) merged.push(tool)
  }
  return merged
}

function compactableMessageIds(ledger: WrapperLedger): string[] {
  return ledger.visibleEntries().flatMap(entry => entry.kind === "message" ? [entry.message.id] : [])
}

function compactionReceipt(result: ReturnType<WrapperLedger["partialCompactRanges"]>, ledger: WrapperLedger): Record<string, unknown> {
  if (!result.ok) return { ok: false, error: result.error }
  return {
    ok: true,
    n_ranges_compacted: result.n_ranges_compacted,
    n_messages_replaced: result.n_messages_replaced,
    compactions: result.records.map(record => ({
      id: record.id,
      from_message_id: record.from_message_id,
      to_message_id: record.to_message_id,
      n_messages_replaced: record.n_messages_replaced,
    })),
    future_model_context_rewritten_by_frontend_proxy_on_next_turn: true,
    visible_message_ids: compactableMessageIds(ledger),
    visible_entry_ids: ledger.currentVisibleMessageIds(),
  }
}

function isThreadMappingResponse(method: string): boolean {
  return method === "thread/start" || method === "thread/resume" || method === "thread/fork"
}

function renderCompletedItemTranscript(params: unknown): string | null {
  if (!isRecord(params) || !isRecord(params.item)) return null
  const item = params.item
  const type = typeof item.type === "string" ? item.type : "unknown"
  if (type === "userMessage" || type === "agentMessage" || type === "plan" || type === "reasoning") return null
  if (type === "dynamicToolCall" && (item.tool === "partial_compact" || item.tool === "partial_compact_current_session_message_ids")) return null
  const rendered = renderNativeItem(item, type)
  return rendered ? `native Codex item completed: ${rendered}` : null
}

function renderNativeItem(item: Record<string, unknown>, type: string): string {
  switch (type) {
    case "commandExecution":
      return JSON.stringify({
        type,
        command: item.command,
        cwd: item.cwd,
        status: item.status,
        exitCode: item.exitCode,
        aggregatedOutput: item.aggregatedOutput,
      })
    case "mcpToolCall":
      return JSON.stringify({
        type,
        server: item.server,
        tool: item.tool,
        status: item.status,
        arguments: item.arguments,
        result: item.result,
        error: item.error,
      })
    case "fileChange":
      return JSON.stringify({
        type,
        status: item.status,
        changes: item.changes,
      })
    case "webSearch":
      return JSON.stringify({
        type,
        query: item.query,
        action: item.action,
      })
    default:
      return JSON.stringify(item)
  }
}

function parsePartialCompactRanges(value: unknown): PartialCompactRange[] {
  if (!isRecord(value) || !Array.isArray(value.ranges) || value.ranges.length === 0) {
    throw new Error("partial_compact missing ranges")
  }
  return value.ranges.map((range, idx) => {
    if (!isRecord(range)) throw new Error(`partial_compact range ${idx} must be an object`)
    if (typeof range.from_message_id !== "string") throw new Error(`partial_compact range ${idx} missing from_message_id`)
    if (typeof range.to_message_id !== "string") throw new Error(`partial_compact range ${idx} missing to_message_id`)
    if (typeof range.summary !== "string") throw new Error(`partial_compact range ${idx} missing summary`)
    return {
      from_message_id: range.from_message_id,
      to_message_id: range.to_message_id,
      summary: range.summary,
    }
  })
}

function extractTurnInputText(params: unknown): string {
  if (!isRecord(params) || !Array.isArray(params.input)) return ""
  return params.input.map(input => {
    if (!isRecord(input)) return ""
    if (typeof input.text === "string") return input.text
    if (Array.isArray(input.content)) {
      return input.content.flatMap(part => isRecord(part) && typeof part.text === "string" ? [part.text] : []).join("\n")
    }
    return ""
  }).filter(Boolean).join("\n")
}

function rewriteThreadIds(value: unknown, from_id: string, to_id: string): unknown {
  if (typeof value === "string") return value === from_id ? to_id : value
  if (Array.isArray(value)) return value.map(item => rewriteThreadIds(item, from_id, to_id))
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] = rewriteThreadIds(item, from_id, to_id)
  }
  return result
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

function isPcodxToolCall(params: unknown): params is Record<string, unknown> {
  return isRecord(params) && (params.tool === "partial_compact" || params.tool === "partial_compact_current_session_message_ids")
}

function parseThreadId(result: unknown, method: string): string {
  if (isRecord(result) && isRecord(result.thread) && typeof result.thread.id === "string") return result.thread.id
  throw new Error(`${method} response omitted thread.id`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number"
}

function isMissingFileError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT"
}

function messageText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
