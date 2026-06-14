import {
  CodexAppServerStdio,
  parseThreadTokenUsageUpdated,
  type CodexThreadTokenUsage,
} from "./app-server-adapter.js"
import { WrapperLedger } from "./ledger.js"
import type { LedgerMessage, MessageRole, PartialCompactArgs, PartialCompactRange, PartialCompactRangesResult, PartialCompactResult } from "./types.js"

type DynamicToolCall = {
  tool: string
  arguments: unknown
}

type DynamicToolResult = {
  success: boolean
  text: string
  compacted?: boolean
}

type QueuedToolTranscript = {
  text: string
  compacted: boolean
}

export type SelfCompactingTurnResult = {
  ok: true
  assistant: string
  thread_id: string
  token_usage: CodexThreadTokenUsage
  n_items_injected: number
  n_tool_calls: number
  visible_context_chars: number
  model_visible_context: string
} | {
  ok: false
  error: string
  assistant: string
  thread_id: string | null
  token_usage: CodexThreadTokenUsage | null
  n_items_injected: number
  n_tool_calls: number
  visible_context_chars: number
  model_visible_context: string
}

export type SelfCompactingControllerOptions = {
  session_id: string
  system_instructions?: string
  cwd?: string
}

const DEFAULT_SYSTEM_INSTRUCTIONS = [
  "You are Codex behind a PCODX self-compacting app-server controller.",
  "Use message ids with partial_compact ranges when old recorded context can be replaced by faithful summaries.",
  "The controller starts each future app-server turn from the compacted ledger render, so successful compaction reduces future model-visible context.",
].join("\n")

const DYNAMIC_TOOLS = [
  {
    name: "partial_compact_current_session_message_ids",
    description: "Return the currently visible PCODX ledger ids after controller-side compactions.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "partial_compact",
    description: "Replace one or more disjoint ranges of prior PCODX ledger messages with faithful summaries for future app-server turns.",
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

export class SelfCompactingCodexController {
  readonly ledger: WrapperLedger
  readonly system_instructions: string
  readonly cwd: string

  constructor(options: SelfCompactingControllerOptions) {
    this.ledger = new WrapperLedger(options.session_id)
    this.system_instructions = options.system_instructions ?? DEFAULT_SYSTEM_INSTRUCTIONS
    this.cwd = options.cwd ?? process.cwd()
  }

  append(role: MessageRole, text: string, source?: string): LedgerMessage {
    return this.ledger.append(role, text, source)
  }

  currentVisibleMessageIds(): string[] {
    return this.ledger.currentVisibleMessageIds()
  }

  compactableMessageIds(): string[] {
    return this.ledger.visibleEntries().flatMap(entry =>
      entry.kind === "message" ? [entry.message.id] : [],
    )
  }

  partialCompact(args: PartialCompactArgs): PartialCompactResult {
    return this.ledger.partialCompact(args)
  }

  partialCompactRanges(ranges: PartialCompactRange[]): PartialCompactRangesResult {
    return this.ledger.partialCompactRanges(ranges)
  }

  renderVisibleContext(): string {
    return this.ledger.renderVisibleContext(this.system_instructions)
  }

  historyItems(visible_context = this.renderVisibleContext()): unknown[] {
    return [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: visible_context }],
    }]
  }

  async runTurn(prompt: string, timeout_ms = 90000): Promise<SelfCompactingTurnResult> {
    const visible_context = this.renderVisibleContext()
    const history_items = this.historyItems(visible_context)
    const queued_tool_transcript: QueuedToolTranscript[] = []
    let assistant = ""
    let thread_id: string | null = null
    let token_usage: CodexThreadTokenUsage | null = null
    let n_tool_calls = 0
    let completeTurn: (turn: unknown) => void = () => {}
    let observeUsage: (usage: CodexThreadTokenUsage) => void = () => {}
    const nextCompletedTurn = (): Promise<unknown> => new Promise(resolve => {
      completeTurn = resolve
    })
    const nextTokenUsage = (): Promise<CodexThreadTokenUsage> => new Promise(resolve => {
      observeUsage = resolve
    })
    const client = new CodexAppServerStdio((method, params) => {
      const usage_event = method === "thread/tokenUsage/updated" ? parseThreadTokenUsageUpdated(params) : null
      if (usage_event) {
        token_usage = usage_event.usage
        observeUsage(usage_event.usage)
      }
      if (method === "item/agentMessage/delta") {
        assistant += String((params as { delta?: unknown }).delta ?? "")
      }
      if (method === "turn/completed") {
        completeTurn((params as { turn?: unknown }).turn)
      }
    }, (method, params) => {
      switch (method) {
        case "item/tool/call":
          n_tool_calls += 1
          return this.#handleToolCall(params, queued_tool_transcript)
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval":
          return { decision: "decline" }
        case "applyPatchApproval":
        case "execCommandApproval":
          return { decision: "denied" }
        case "item/permissions/requestApproval":
          return { permissions: {}, scope: "turn", strictAutoReview: true }
        default:
          throw new Error(`unsupported app-server request ${method}`)
      }
    })
    const timer = AbortSignal.timeout(timeout_ms)
    const n_items_injected = history_items.length
    try {
      await withTimeout(client.request("initialize", {
        clientInfo: {
          name: "pcodx_self_compacting_controller",
          title: "PCODX Self-Compacting Controller",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      }), timer)
      client.notify("initialized", {})
      const thread = parseThreadStartResult(await withTimeout(client.request("thread/start", {
        ephemeral: true,
        cwd: this.cwd,
        baseInstructions: "You are a concise coding assistant.",
        developerInstructions: this.system_instructions,
        dynamicTools: DYNAMIC_TOOLS,
      }), timer))
      thread_id = thread.thread_id
      await withTimeout(client.request("thread/inject_items", { threadId: thread_id, items: history_items }), timer)
      const usage_observed = nextTokenUsage()
      const turn_completed = nextCompletedTurn()
      await withTimeout(client.request("turn/start", {
        threadId: thread_id,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      }), timer)
      const turn = parseTurn(await withTimeout(turn_completed, timer))
      token_usage = token_usage ?? await withTimeoutOrNull(usage_observed, AbortSignal.timeout(3000))
      const compacted_this_turn = queued_tool_transcript.some(tool => tool.compacted)
      if (compacted_this_turn) {
        for (const tool of queued_tool_transcript) {
          this.ledger.append("tool", tool.text, "controller:tool")
        }
        this.ledger.append(
          "assistant",
          "Controller omitted the current turn prompt and assistant text from future ledger state after compaction so raw pre-compaction context is not reintroduced.",
          "controller:post-compact",
        )
      } else {
        this.ledger.append("user", prompt, "controller:user")
        for (const tool of queued_tool_transcript) {
          this.ledger.append("tool", tool.text, "controller:tool")
        }
        this.ledger.append("assistant", assistant.trim() || "(empty assistant response)", "controller:assistant")
      }
      if (turn.status !== "completed") {
        return this.#failed(`turn status ${turn.status}`, assistant, thread_id, token_usage, n_items_injected, n_tool_calls, visible_context)
      }
      if (!token_usage) {
        return this.#failed("turn completed without app-server token usage notification", assistant, thread_id, token_usage, n_items_injected, n_tool_calls, visible_context)
      }
      return {
        ok: true,
        assistant,
        thread_id,
        token_usage,
        n_items_injected,
        n_tool_calls,
        visible_context_chars: visible_context.length,
        model_visible_context: visible_context,
      }
    } catch (err) {
      return this.#failed(sanitizeError(String((err as Error).message ?? err)), assistant, thread_id, token_usage, n_items_injected, n_tool_calls, visible_context)
    } finally {
      client.close()
    }
  }

  #handleToolCall(params: unknown, queued_tool_transcript: QueuedToolTranscript[]): unknown {
    const call = parseDynamicToolCall(params)
    const result = this.#executeTool(call)
    queued_tool_transcript.push({ text: `${call.tool} result: ${result.text}`, compacted: result.compacted ?? false })
    return {
      contentItems: [{ type: "inputText", text: result.text }],
      success: result.success,
    }
  }

  #executeTool(call: DynamicToolCall): DynamicToolResult {
    switch (call.tool) {
      case "partial_compact_current_session_message_ids":
        return {
          success: true,
          text: JSON.stringify({
            ok: true,
            visible_message_ids: this.compactableMessageIds(),
            visible_entry_ids: this.currentVisibleMessageIds(),
            future_model_visible_context_source: "pcodx app-server controller ledger render",
          }, null, 2),
      }
      case "partial_compact": {
        const ranges = parsePartialCompactRanges(call.arguments)
        const result = this.partialCompactRanges(ranges)
        return {
          success: result.ok,
          compacted: result.ok,
          text: JSON.stringify(compactionReceipt(result, this.compactableMessageIds(), this.currentVisibleMessageIds()), null, 2),
        }
      }
      default:
        return {
          success: false,
          text: JSON.stringify({ ok: false, error: `unknown dynamic tool ${call.tool}` }, null, 2),
        }
    }
  }

  #failed(
    error: string,
    assistant: string,
    thread_id: string | null,
    token_usage: CodexThreadTokenUsage | null,
    n_items_injected: number,
    n_tool_calls: number,
    visible_context: string,
  ): SelfCompactingTurnResult {
    return {
      ok: false,
      error,
      assistant,
      thread_id,
      token_usage,
      n_items_injected,
      n_tool_calls,
      visible_context_chars: visible_context.length,
      model_visible_context: visible_context,
    }
  }
}

function parseDynamicToolCall(params: unknown): DynamicToolCall {
  if (!isRecord(params)) throw new Error("dynamic tool call params must be an object")
  if (typeof params.tool !== "string") throw new Error("dynamic tool call omitted tool name")
  return { tool: params.tool, arguments: params.arguments }
}

function parsePartialCompactRanges(value: unknown): PartialCompactRange[] {
  if (!isRecord(value)) throw new Error("partial_compact arguments must be an object")
  const ranges = value.ranges
  if (!Array.isArray(ranges) || ranges.length === 0) throw new Error("partial_compact missing ranges")
  return ranges.map((range, idx) => {
    if (!isRecord(range)) throw new Error(`partial_compact range ${idx} must be an object`)
    const from_message_id = range.from_message_id
    const to_message_id = range.to_message_id
    const summary = range.summary
    if (typeof from_message_id !== "string") throw new Error(`partial_compact range ${idx} missing from_message_id`)
    if (typeof to_message_id !== "string") throw new Error(`partial_compact range ${idx} missing to_message_id`)
    if (typeof summary !== "string") throw new Error(`partial_compact range ${idx} missing summary`)
    return { from_message_id, to_message_id, summary }
  })
}

function compactionReceipt(
  result: PartialCompactRangesResult,
  visible_message_ids: string[],
  visible_entry_ids: string[],
): Record<string, unknown> {
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
    future_model_context_rewritten_by_controller_on_next_turn: true,
    visible_message_ids,
    visible_entry_ids,
  }
}

async function withTimeout<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("codex app-server controller timed out")
  return await new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error("codex app-server controller timed out"))
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sanitizeError(message: string): string {
  return message
    .replaceAll(process.cwd(), "<cwd>")
    .replace(/\/home\/[A-Za-z0-9._/-]+/g, "<home-path>")
    .replace(/\/ssd[0-9]+\/[A-Za-z0-9._/-]+/g, "<workspace-path>")
}
