import { spawn } from "node:child_process"
import readline from "node:readline"
import { loadSharedPrompt, renderSharedPrompt } from "./shared-prompts.js"

type RequestId = string | number

type JsonRpcMessage = {
  id?: unknown
  result?: unknown
  error?: { message?: unknown }
  method?: unknown
  params?: unknown
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  method: string
}

type NotificationHandler = (method: string, params: unknown) => void
type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown

export type TokenUsageBreakdown = {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export type CodexThreadTokenUsage = {
  total: TokenUsageBreakdown
  last: TokenUsageBreakdown
  modelContextWindow: number | null
}

export type ThreadTokenUsageEvent = {
  thread_id: string
  turn_id: string
  usage: CodexThreadTokenUsage
}

export type AppServerAdditionalContext = Record<string, { value: string; kind: "application" }>

export const CONTEXT_WINDOW_REMINDER_CONTEXT_KEY = "pcodx.context_window_reminder"

const CONTEXT_WINDOW_REMINDER_INTERVAL_TOKENS = 16_000
const COMPACT_NOW_CONTEXT_FRACTION = 0.8

export type CodexContextInjectionProbe = {
  ok: true
  user_agent: string
  platform: string
  n_items_injected: number
} | {
  ok: false
  error: string
}

export type CodexLiveTurnSmoke = {
  ok: true
  status: string
  assistant: string
  n_items_injected: number
  n_context_reminders_injected: number
  turns_completed: number
  token_usage: CodexThreadTokenUsage | null
  context_window_reminder: string | null
} | {
  ok: false
  error: string
  assistant: string
  n_context_reminders_injected: number
  turns_completed: number
  token_usage: CodexThreadTokenUsage | null
  context_window_reminder: string | null
}

export type CodexSingleTurnUsage = {
  ok: true
  assistant: string
  thread_id: string
  n_items_injected: number
  turns_completed: number
  token_usage: CodexThreadTokenUsage
} | {
  ok: false
  error: string
  assistant: string
  thread_id: string | null
  turns_completed: number
  token_usage: CodexThreadTokenUsage | null
}

export class ContextWindowReminderTracker {
  #latest_by_thread_id = new Map<string, CodexThreadTokenUsage>()
  #last_reminder_input_tokens_by_thread_id = new Map<string, number>()
  readonly #reminder_interval_tokens: number

  constructor(reminder_interval_tokens = CONTEXT_WINDOW_REMINDER_INTERVAL_TOKENS) {
    this.#reminder_interval_tokens = reminder_interval_tokens
  }

  observe(method: string, params: unknown): ThreadTokenUsageEvent | null {
    if (method !== "thread/tokenUsage/updated") return null
    const event = parseThreadTokenUsageUpdated(params)
    if (!event) return null
    this.#latest_by_thread_id.set(event.thread_id, event.usage)
    return event
  }

  latest(thread_id: string): CodexThreadTokenUsage | null {
    return this.#latest_by_thread_id.get(thread_id) ?? null
  }

  reminderText(thread_id: string): string | null {
    const usage = this.latest(thread_id)
    return usage ? renderContextWindowReminder(usage) : null
  }

  additionalContext(thread_id: string): AppServerAdditionalContext | undefined {
    const usage = this.latest(thread_id)
    if (!usage || !this.#reminderDue(thread_id, usage)) return undefined
    const reminder = this.reminderText(thread_id)
    if (!reminder) return undefined
    this.#last_reminder_input_tokens_by_thread_id.set(thread_id, usage.last.inputTokens)
    return {
      [CONTEXT_WINDOW_REMINDER_CONTEXT_KEY]: {
        kind: "application",
        value: reminder,
      },
    }
  }

  #reminderDue(thread_id: string, usage: CodexThreadTokenUsage): boolean {
    const interval = effectiveContextReminderInterval(this.#reminder_interval_tokens, usage.modelContextWindow)
    if (interval === null) return false
    const input_tokens = usage.last.inputTokens
    const last_input_tokens = this.#last_reminder_input_tokens_by_thread_id.get(thread_id) ?? 0
    if (input_tokens < last_input_tokens) {
      this.#last_reminder_input_tokens_by_thread_id.set(thread_id, input_tokens)
      return false
    }
    const level_due = crossedContextUsageLevel(input_tokens, last_input_tokens, usage.modelContextWindow)
    if (input_tokens < interval && !level_due) return false
    return input_tokens - last_input_tokens >= interval || level_due
  }
}

export class CodexAppServerStdio {
  #proc = spawn("codex", ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
  })
  #rl = readline.createInterface({ input: this.#proc.stdout })
  #pending = new Map<RequestId, PendingRequest>()
  #next_id = 1
  #stderr = ""
  #closed = false
  #on_notification: NotificationHandler | undefined
  #on_server_request: ServerRequestHandler | undefined

  constructor(on_notification?: NotificationHandler, on_server_request?: ServerRequestHandler) {
    this.#on_notification = on_notification
    this.#on_server_request = on_server_request
    this.#proc.stderr.on("data", chunk => {
      this.#stderr += String(chunk)
    })
    this.#proc.on("error", err => {
      this.#rejectAll(err)
    })
    this.#proc.on("close", code => {
      this.#closed = true
      this.#rejectAll(new Error(this.#stderr.trim() || `codex app-server exited ${code}`))
    })
    this.#rl.on("line", line => {
      this.#handleLine(line)
    })
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("codex app-server is closed"))
    const id = this.#next_id
    this.#next_id += 1
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method })
      this.#proc.stdin.write(`${JSON.stringify({ method, id, params })}\n`)
    })
  }

  notify(method: string, params: unknown): void {
    if (!this.#closed) this.#proc.stdin.write(`${JSON.stringify({ method, params })}\n`)
  }

  close(): void {
    this.#closed = true
    this.#rl.close()
    this.#proc.kill("SIGTERM")
  }

  #handleLine(line: string): void {
    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(line) as JsonRpcMessage
    } catch {
      this.#rejectAll(new Error(`invalid app-server json: ${line}`))
      return
    }
    if (isRequestId(msg.id) && typeof msg.method === "string") {
      void this.#handleServerRequest(msg.id, msg.method, msg.params)
      return
    }
    if (!isRequestId(msg.id)) {
      if (typeof msg.method === "string") this.#on_notification?.(msg.method, msg.params)
      return
    }
    const pending = this.#pending.get(msg.id)
    if (!pending) return
    this.#pending.delete(msg.id)
    if (msg.error) {
      pending.reject(new Error(`${pending.method}: ${String(msg.error.message ?? "failed")}`))
      return
    }
    pending.resolve(msg.result)
  }

  async #handleServerRequest(id: RequestId, method: string, params: unknown): Promise<void> {
    try {
      if (!this.#on_server_request) throw new Error(`unhandled app-server request ${method}`)
      this.#proc.stdin.write(`${JSON.stringify({ id, result: await this.#on_server_request(method, params) })}\n`)
    } catch (err) {
      const message = String((err as Error).message ?? err)
      this.#proc.stdin.write(`${JSON.stringify({ id, error: { message } })}\n`)
    }
  }

  #rejectAll(err: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(err)
    }
    this.#pending.clear()
  }
}

export async function probeCuratedContextInjection(
  visible_context: string,
  timeout_ms = 8000,
): Promise<CodexContextInjectionProbe> {
  const client = new CodexAppServerStdio()
  const timer = AbortSignal.timeout(timeout_ms)
  try {
    const result = await withTimeout(client.request("initialize", {
      clientInfo: {
        name: "opc_partial_compact_probe",
        title: "OPC Partial Compact Probe",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    }), timer)
    client.notify("initialized", {})
    const init = parseInitializeResult(result)
    const thread = parseThreadStartResult(await withTimeout(client.request("thread/start", {
      ephemeral: true,
      cwd: process.cwd(),
      baseInstructions: "OPC partial-compaction wrapper probe.",
      developerInstructions: "Accept curated context injected by the wrapper.",
    }), timer))
    const items = [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: visible_context }],
    }]
    await withTimeout(client.request("thread/inject_items", { threadId: thread.thread_id, items }), timer)
    return {
      ok: true,
      user_agent: init.user_agent,
      platform: init.platform,
      n_items_injected: items.length,
    }
  } catch (err) {
    return { ok: false, error: sanitizeError(String((err as Error).message ?? err)) }
  } finally {
    client.close()
  }
}

export async function runCuratedLiveTurnSmoke(
  visible_context: string,
  prompt: string,
  timeout_ms = 90000,
): Promise<CodexLiveTurnSmoke> {
  let assistant = ""
  let completeTurn: (turn: unknown) => void = () => {}
  let observeUsage: (usage: CodexThreadTokenUsage) => void = () => {}
  let turns_completed = 0
  let n_context_reminders_injected = 0
  let context_window_reminder: string | null = null
  let token_usage: CodexThreadTokenUsage | null = null
  const nextCompletedTurn = (): Promise<unknown> => new Promise(resolve => {
    completeTurn = resolve
  })
  const nextTokenUsage = (): Promise<CodexThreadTokenUsage> => new Promise(resolve => {
    observeUsage = resolve
  })
  const reminders = new ContextWindowReminderTracker()
  const client = new CodexAppServerStdio((method, params) => {
    const usage_event = reminders.observe(method, params)
    if (usage_event) observeUsage(usage_event.usage)
    if (method === "item/agentMessage/delta") {
      assistant += String((params as { delta?: unknown }).delta ?? "")
    }
    if (method === "turn/completed") {
      completeTurn((params as { turn?: unknown }).turn)
    }
  })
  const timer = AbortSignal.timeout(timeout_ms)
  try {
    await withTimeout(client.request("initialize", {
      clientInfo: {
        name: "opc_partial_compact_live_probe",
        title: "OPC Partial Compact Live Probe",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    }), timer)
    client.notify("initialized", {})
    const thread = parseThreadStartResult(await withTimeout(client.request("thread/start", {
      ephemeral: true,
      cwd: process.cwd(),
      baseInstructions: "You are a concise coding assistant.",
      developerInstructions: "Use injected curated context as prior conversation state.",
    }), timer))
    const items = [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: visible_context }],
    }]
    await withTimeout(client.request("thread/inject_items", { threadId: thread.thread_id, items }), timer)
    const first_usage_observed = nextTokenUsage()
    const first_turn_completed = nextCompletedTurn()
    await withTimeout(client.request("turn/start", {
      threadId: thread.thread_id,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    }), timer)
    const first_turn = parseTurn(await withTimeout(first_turn_completed, timer))
    turns_completed += 1
    token_usage = reminders.latest(thread.thread_id) ??
      await withTimeoutOrNull(first_usage_observed, AbortSignal.timeout(3000))
    if (first_turn.status !== "completed") {
      return {
        ok: false,
        error: `turn status ${first_turn.status}`,
        assistant,
        n_context_reminders_injected,
        turns_completed,
        token_usage,
        context_window_reminder,
      }
    }
    if (!token_usage) {
      return {
        ok: false,
        error: "turn completed without app-server token usage notification",
        assistant,
        n_context_reminders_injected,
        turns_completed,
        token_usage,
        context_window_reminder,
      }
    }
    const additionalContext = reminders.additionalContext(thread.thread_id)
    context_window_reminder = reminders.reminderText(thread.thread_id)
    if (!additionalContext || !context_window_reminder) {
      return {
        ok: false,
        error: "token usage did not render a context-window reminder",
        assistant,
        n_context_reminders_injected,
        turns_completed,
        token_usage,
        context_window_reminder,
      }
    }
    const second_turn_completed = nextCompletedTurn()
    await withTimeout(client.request("turn/start", {
      threadId: thread.thread_id,
      input: [{
        type: "text",
        text: "Acknowledge the app-server context reminder in one short sentence. Do not run tools.",
        text_elements: [],
      }],
      additionalContext,
    }), timer)
    n_context_reminders_injected += 1
    const second_turn = parseTurn(await withTimeout(second_turn_completed, timer))
    turns_completed += 1
    if (second_turn.status !== "completed") {
      return {
        ok: false,
        error: `follow-up turn status ${second_turn.status}`,
        assistant,
        n_context_reminders_injected,
        turns_completed,
        token_usage,
        context_window_reminder,
      }
    }
    return {
      ok: true,
      status: second_turn.status,
      assistant,
      n_items_injected: items.length,
      n_context_reminders_injected,
      turns_completed,
      token_usage,
      context_window_reminder,
    }
  } catch (err) {
    return {
      ok: false,
      error: sanitizeError(String((err as Error).message ?? err)),
      assistant,
      n_context_reminders_injected,
      turns_completed,
      token_usage,
      context_window_reminder,
    }
  } finally {
    client.close()
  }
}

export async function runCuratedSingleTurnUsage(
  visible_context: string,
  prompt: string,
  timeout_ms = 90000,
): Promise<CodexSingleTurnUsage> {
  let assistant = ""
  let completeTurn: (turn: unknown) => void = () => {}
  let observeUsage: (usage: CodexThreadTokenUsage) => void = () => {}
  let turns_completed = 0
  let thread_id: string | null = null
  let token_usage: CodexThreadTokenUsage | null = null
  const nextCompletedTurn = (): Promise<unknown> => new Promise(resolve => {
    completeTurn = resolve
  })
  const nextTokenUsage = (): Promise<CodexThreadTokenUsage> => new Promise(resolve => {
    observeUsage = resolve
  })
  const reminders = new ContextWindowReminderTracker()
  const client = new CodexAppServerStdio((method, params) => {
    const usage_event = reminders.observe(method, params)
    if (usage_event) observeUsage(usage_event.usage)
    if (method === "item/agentMessage/delta") {
      assistant += String((params as { delta?: unknown }).delta ?? "")
    }
    if (method === "turn/completed") {
      completeTurn((params as { turn?: unknown }).turn)
    }
  })
  const timer = AbortSignal.timeout(timeout_ms)
  try {
    await withTimeout(client.request("initialize", {
      clientInfo: {
        name: "opc_partial_compact_usage_probe",
        title: "OPC Partial Compact Usage Probe",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    }), timer)
    client.notify("initialized", {})
    const thread = parseThreadStartResult(await withTimeout(client.request("thread/start", {
      ephemeral: true,
      cwd: process.cwd(),
      baseInstructions: "You are a concise coding assistant.",
      developerInstructions: "Use injected curated context as prior conversation state.",
    }), timer))
    thread_id = thread.thread_id
    const items = [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: visible_context }],
    }]
    await withTimeout(client.request("thread/inject_items", { threadId: thread.thread_id, items }), timer)
    const first_usage_observed = nextTokenUsage()
    const first_turn_completed = nextCompletedTurn()
    await withTimeout(client.request("turn/start", {
      threadId: thread.thread_id,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    }), timer)
    const first_turn = parseTurn(await withTimeout(first_turn_completed, timer))
    turns_completed += 1
    token_usage = reminders.latest(thread.thread_id) ??
      await withTimeoutOrNull(first_usage_observed, AbortSignal.timeout(3000))
    if (first_turn.status !== "completed") {
      return { ok: false, error: `turn status ${first_turn.status}`, assistant, thread_id, turns_completed, token_usage }
    }
    if (!token_usage) {
      return { ok: false, error: "turn completed without app-server token usage notification", assistant, thread_id, turns_completed, token_usage }
    }
    return {
      ok: true,
      assistant,
      thread_id,
      n_items_injected: items.length,
      turns_completed,
      token_usage,
    }
  } catch (err) {
    return {
      ok: false,
      error: sanitizeError(String((err as Error).message ?? err)),
      assistant,
      thread_id,
      turns_completed,
      token_usage,
    }
  } finally {
    client.close()
  }
}

async function withTimeout<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("codex app-server probe timed out")
  return await new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error("codex app-server probe timed out"))
    signal.addEventListener("abort", abort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener("abort", abort)
        resolve(value)
      },
      err => {
        signal.removeEventListener("abort", abort)
        reject(err)
      },
    )
  })
}

async function withTimeoutOrNull<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return null
  return await new Promise(resolve => {
    const abort = (): void => resolve(null)
    signal.addEventListener("abort", abort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener("abort", abort)
        resolve(value)
      },
      () => {
        signal.removeEventListener("abort", abort)
        resolve(null)
      },
    )
  })
}

export function parseThreadTokenUsageUpdated(params: unknown): ThreadTokenUsageEvent | null {
  if (!isRecord(params)) return null
  const thread_id = typeof params.threadId === "string" ? params.threadId : ""
  const turn_id = typeof params.turnId === "string" ? params.turnId : ""
  if (!thread_id || !turn_id) return null
  const usage = parseThreadTokenUsage(params.tokenUsage)
  return usage ? { thread_id, turn_id, usage } : null
}

export function renderContextWindowReminder(usage: CodexThreadTokenUsage): string {
  const last_input_tokens = usage.last.inputTokens
  const context_window = usableContextWindow(usage.modelContextWindow)
  return renderSharedPrompt(loadSharedPrompt("partial-compact-reminder.md"), {
    CONTEXT_STATUS: contextStatusText(last_input_tokens, context_window),
  }).replace(/\s*\n+\s*/g, " ").trim()
}

function parseThreadTokenUsage(raw: unknown): CodexThreadTokenUsage | null {
  if (!isRecord(raw)) return null
  const total = parseTokenUsageBreakdown(raw.total)
  const last = parseTokenUsageBreakdown(raw.last)
  if (!total || !last) return null
  const modelContextWindow = raw.modelContextWindow === null
    ? null
    : usableContextWindow(raw.modelContextWindow)
  return { total, last, modelContextWindow }
}

function parseTokenUsageBreakdown(raw: unknown): TokenUsageBreakdown | null {
  if (!isRecord(raw)) return null
  const totalTokens = finiteNumber(raw.totalTokens)
  const inputTokens = finiteNumber(raw.inputTokens)
  const cachedInputTokens = finiteNumber(raw.cachedInputTokens)
  const outputTokens = finiteNumber(raw.outputTokens)
  const reasoningOutputTokens = finiteNumber(raw.reasoningOutputTokens)
  if (
    totalTokens === null ||
    inputTokens === null ||
    cachedInputTokens === null ||
    outputTokens === null ||
    reasoningOutputTokens === null
  ) return null
  return { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens }
}

function contextStatusText(input_tokens: number, context_window: number | null): string {
  if (context_window === null) return `current context window: ${tokenKText(input_tokens)} (unknown% full)`
  return `current context window: ${tokenKText(input_tokens)} (${Math.min(999, Math.round(input_tokens / context_window * 100))}% full)`
}

function effectiveContextReminderInterval(configured_interval_tokens: number, context_window: number | null): number | null {
  if (!Number.isFinite(configured_interval_tokens) || configured_interval_tokens <= 0) return null
  if (context_window === null || context_window >= configured_interval_tokens) return configured_interval_tokens
  return Math.max(1, Math.floor(context_window * COMPACT_NOW_CONTEXT_FRACTION))
}

function crossedContextUsageLevel(input_tokens: number, last_input_tokens: number, context_window: number | null): boolean {
  return contextUsageRank(input_tokens, context_window) > contextUsageRank(last_input_tokens, context_window)
}

function contextUsageRank(input_tokens: number, context_window: number | null): number {
  if (context_window === null) return 0
  const fraction = input_tokens / context_window
  if (fraction >= 0.9) return 4
  if (fraction >= COMPACT_NOW_CONTEXT_FRACTION) return 3
  if (fraction >= 0.5) return 2
  return 1
}

function usableContextWindow(value: unknown): number | null {
  const n = finiteNumber(value)
  return n === null || n <= 0 ? null : n
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function tokenKText(tokens: number): string {
  const thousands = tokens / 1000
  if (thousands >= 10) return `${Math.round(thousands)}k`
  return `${Math.round(thousands * 10) / 10}k`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number"
}

function parseInitializeResult(raw: unknown): { user_agent: string; platform: string } {
  const msg = raw as { userAgent?: unknown; platformFamily?: unknown; platformOs?: unknown }
  if (typeof msg.userAgent !== "string") throw new Error("initialize response omitted userAgent")
  const family = typeof msg.platformFamily === "string" ? msg.platformFamily : "unknown"
  const os = typeof msg.platformOs === "string" ? msg.platformOs : "unknown"
  return { user_agent: msg.userAgent, platform: `${family}/${os}` }
}

function parseThreadStartResult(raw: unknown): { thread_id: string } {
  const msg = raw as { thread?: { id?: unknown } }
  if (typeof msg.thread?.id !== "string") throw new Error("thread/start response omitted thread.id")
  return { thread_id: msg.thread.id }
}

function parseTurn(raw: unknown): { status: string } {
  const msg = raw as { status?: unknown }
  if (typeof msg.status !== "string") throw new Error("turn/completed omitted status")
  return { status: msg.status }
}

function sanitizeError(message: string): string {
  return message
    .replaceAll(process.cwd(), "<cwd>")
    .replace(/\/home\/[A-Za-z0-9._/-]+/g, "<home-path>")
    .replace(/\/ssd[0-9]+\/[A-Za-z0-9._/-]+/g, "<workspace-path>")
}
