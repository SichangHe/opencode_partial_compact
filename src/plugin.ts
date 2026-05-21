import { readFile } from "node:fs/promises"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import type { PluginInput, Plugin } from "@opencode-ai/plugin"
import { setLogPath, debugLog } from "./log.js"
import { messagesTransformHandler } from "./hook.js"
import { maybeInjectReminder } from "./reminder.js"
import { buildCompactTool } from "./tool.js"
import type { PluginConfig } from "./tool.js"

const CONFIG_FILENAME = "opencode-partial-compact.jsonc"

const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  max_summary_chars: 2000,
  debug_log_path: null,
  reminder_enabled: true,
  reminder_context_fraction: 0.1,
  reminder_min_tokens: 4000,
}

/** Walk up from cwd to $HOME looking for .opencode/{CONFIG_FILENAME}. */
async function findProjectConfig(startDir: string): Promise<string | null> {
  const home = homedir()
  let dir = startDir
  while (true) {
    const candidate = join(dir, ".opencode", CONFIG_FILENAME)
    try {
      await readFile(candidate)
      return candidate
    } catch {
      // not here
    }
    if (dir === home || dirname(dir) === dir) break
    dir = dirname(dir)
  }
  return null
}

async function loadConfig(directory: string): Promise<PluginConfig> {
  let configPath = await findProjectConfig(directory)
  if (!configPath) {
    configPath = join(homedir(), ".config", "opencode", CONFIG_FILENAME)
  }
  try {
    const raw = await readFile(configPath, "utf8")
    const stripped = raw.replace(/\/\/[^\n]*/g, "")
    const parsed = JSON.parse(stripped) as Partial<PluginConfig>
    return { ...DEFAULT_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/**
 * Coexistence check. Runs lazily on first chat hook fire,
 * NOT during `server()` — the HTTP server isn't ready at plugin-load time
 * and calling `client.config.get()` then would hang opencode bootstrap.
 *
 * Once-shot: throws iff DCP is co-installed OR oh-my-openagent is listed
 * before us. The thrown error propagates out of the hook and is surfaced
 * to the user on their first chat turn.
 */
export function makeCoexistenceCheck(
  client: PluginInput["client"],
): () => Promise<void> {
  let done = false
  return async () => {
    if (done) return
    done = true
    let pluginList: string[]
    try {
      const resp = await client.config.get({ throwOnError: true })
      const raw = (resp.data?.plugin ?? []) as Array<string | [string, unknown]>
      pluginList = raw.map(e => Array.isArray(e) ? e[0] : e)
    } catch (err) {
      debugLog(`Coexistence check skipped — config fetch failed: ${String(err)}`)
      return
    }

    const ourName = "opencode-partial-compact"
    if (pluginList.includes("@tarquinen/opencode-dcp")) {
      throw new Error(
        "opencode-partial-compact: refusing to operate — @tarquinen/opencode-dcp is " +
        "also configured. They overlap and conflict. Pick one and remove the other " +
        "from opencode.json.",
      )
    }
    const omoIdx = pluginList.indexOf("oh-my-openagent")
    const ourIdx = pluginList.findIndex(p =>
      p === ourName || p.endsWith("opencode_partial_compact/dist/index.js"),
    )
    if (omoIdx !== -1 && ourIdx !== -1 && omoIdx < ourIdx) {
      throw new Error(
        "opencode-partial-compact: refusing to operate — list this plugin BEFORE " +
        "oh-my-openagent in opencode.json.",
      )
    }
    debugLog("Coexistence check passed")
  }
}

/**
 * The plugin server function. NO blocking I/O here — opencode awaits the
 * server() return before its HTTP server is ready, so any await on
 * ctx.client.* will hang bootstrap. Coexistence checks are deferred.
 */
export const server: Plugin = async (ctx) => {
  const cfg = await loadConfig(ctx.directory)
  if (cfg.debug_log_path) setLogPath(cfg.debug_log_path)
  debugLog("Plugin server() initialised")

  const coexistenceCheck = makeCoexistenceCheck(ctx.client)

  const wrappedHook = cfg.enabled
    ? async (input: object, output: { messages: Array<{ info: { id: string; sessionID: string }; parts: unknown[] }> }) => {
        await coexistenceCheck()
        await messagesTransformHandler(input, output as Parameters<typeof messagesTransformHandler>[1], {
          resolveSessionMessageIDs: async (sessionID: string) => {
            const resp = await ctx.client.session.messages({
              path: { id: sessionID },
              throwOnError: true,
            })
            return new Set((resp.data ?? []).map(msg => msg.info.id))
          },
        })
      }
    : async () => { /* no-op when disabled */ }

  const wrappedSystemHook = cfg.enabled
    ? async (input: { sessionID?: string; model?: { limit?: { context?: number } } }, output: { system: string[] }) => {
        if (!input.sessionID) return
        await coexistenceCheck()
        const resp = await ctx.client.session.messages({
          path: { id: input.sessionID },
          throwOnError: true,
        })
        const reminderInput = {
          sessionID: input.sessionID,
          output,
          messages: resp.data ?? [],
          cfg,
          ...(input.model ? { model: input.model } : {}),
        }
        await maybeInjectReminder(reminderInput)
      }
    : async () => { /* no-op when disabled */ }

  return {
    tool: { partial_compact: buildCompactTool(ctx.client, cfg) },
    "experimental.chat.messages.transform": wrappedHook,
    "experimental.chat.system.transform": wrappedSystemHook,
  }
}
