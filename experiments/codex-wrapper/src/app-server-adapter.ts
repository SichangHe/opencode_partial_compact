import { spawn } from "node:child_process"
import readline from "node:readline"

type JsonRpcResponse = {
  id?: unknown
  result?: unknown
  error?: { message?: unknown }
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  method: string
}

export type CodexContextInjectionProbe = {
  ok: true
  user_agent: string
  platform: string
  n_items_injected: number
} | {
  ok: false
  error: string
}

class CodexAppServerStdio {
  #proc = spawn("codex", ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
  })
  #rl = readline.createInterface({ input: this.#proc.stdout })
  #pending = new Map<number, PendingRequest>()
  #next_id = 1
  #stderr = ""
  #closed = false

  constructor() {
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
    let msg: JsonRpcResponse
    try {
      msg = JSON.parse(line) as JsonRpcResponse
    } catch {
      this.#rejectAll(new Error(`invalid app-server json: ${line}`))
      return
    }
    if (typeof msg.id !== "number") return
    const pending = this.#pending.get(msg.id)
    if (!pending) return
    this.#pending.delete(msg.id)
    if (msg.error) {
      pending.reject(new Error(`${pending.method}: ${String(msg.error.message ?? "failed")}`))
      return
    }
    pending.resolve(msg.result)
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

function sanitizeError(message: string): string {
  return message
    .replaceAll(process.cwd(), "<cwd>")
    .replace(/\/home\/[A-Za-z0-9._/-]+/g, "<home-path>")
    .replace(/\/ssd[0-9]+\/[A-Za-z0-9._/-]+/g, "<workspace-path>")
}
