import { readFile } from "node:fs/promises"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import type { Plugin } from "@opencode-ai/plugin"
import { setLogPath, debugLog } from "./log.js"
import { messagesTransformHandler } from "./hook.js"
import { maybeInjectReminder } from "./reminder.js"
import { buildCompactTool, buildCurrentSessionMessageIDsToolWithClient, buildInstructionToolWithClient } from "./tool.js"
import type { PluginConfig } from "./tool.js"

const CONFIG_FILENAME = "opencode-partial-compact.jsonc"

const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  max_summary_chars: 2000,
  debug_log_path: null,
  reminder_enabled: true,
  reminder_interval_tokens: 16000,
}

type ConfigData = {
  plugin?: Array<string | [string, unknown]>
  compaction?: { auto?: boolean }
}

type ConfigClient = {
  config: {
    get(input: { throwOnError: true }): Promise<{ data?: ConfigData }>
  }
}

type RawPluginConfig = Partial<PluginConfig> & {
  reminder_context_fraction?: number
  reminder_min_tokens?: number
}

export function normalizePluginConfig(parsed: RawPluginConfig): PluginConfig {
  const cfg = { ...DEFAULT_CONFIG, ...parsed }
  if (
    parsed.reminder_interval_tokens === undefined &&
    typeof parsed.reminder_context_fraction === "number" &&
    typeof parsed.reminder_min_tokens === "number" &&
    Number.isFinite(parsed.reminder_context_fraction) &&
    Number.isFinite(parsed.reminder_min_tokens) &&
    parsed.reminder_context_fraction > 0 &&
    parsed.reminder_min_tokens > 0
  ) {
    cfg.reminder_interval_tokens = Math.max(
      parsed.reminder_min_tokens,
      Math.floor(parsed.reminder_min_tokens * 10 * parsed.reminder_context_fraction),
    )
    debugLog("Migrated deprecated reminder_context_fraction/reminder_min_tokens config to reminder_interval_tokens")
  }
  return cfg
}

/**
 * Disable Opencode's native auto-compaction in the merged runtime config.
 *
 * The lazy config check below is still useful as a fail-safe, but it runs too
 * late to be the primary protection: Opencode decides whether to schedule
 * native overflow compaction from the live config during session prompting.
 * Mutating the config hook's merged object keeps that scheduler off even when a
 * user-level or project-level config forgot to set `compaction.auto=false`.
 */
export function disableNativeAutoCompaction(configData: ConfigData): void {
  configData.compaction = { ...(configData.compaction ?? {}), auto: false }
}

export function disableNativeAutoCompactionWhenEnabled(configData: ConfigData, cfg: Pick<PluginConfig, "enabled">): void {
  if (!cfg.enabled) return
  disableNativeAutoCompaction(configData)
}

function modelLimitSnapshot(model: { limit?: { context?: number; input?: number; output?: number } } | undefined): string {
  const limit = model?.limit
  if (!limit) return "model_limit=unknown"
  return `model_limit.context=${limit.context ?? "unknown"} model_limit.input=${limit.input ?? "unknown"} model_limit.output=${limit.output ?? "unknown"}`
}

export async function allowNativeCompactionFallback(input: { sessionID: string }): Promise<void> {
  debugLog(`Allowing native compaction fallback for session=${input.sessionID}`)
}

export function nativeCompactionFallbackHook(coexistenceCheck: () => Promise<void>) {
  return async (input: { sessionID: string }): Promise<void> => {
    await coexistenceCheck()
    await allowNativeCompactionFallback(input)
  }
}

export function disableNativeCompactionAutocontinue(
  input: { sessionID: string; overflow: boolean },
  output: { enabled: boolean },
): void {
  if (input.overflow) {
    debugLog(`Kept native compaction auto-continue enabled for overflow fallback session=${input.sessionID}`)
    return
  }
  output.enabled = false
  debugLog(`Disabled native compaction auto-continue for session=${input.sessionID} overflow=${input.overflow}`)
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
    const parsed = JSON.parse(stripped) as RawPluginConfig
    return normalizePluginConfig(parsed)
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
  client: ConfigClient,
): () => Promise<void> {
  let done = false
  return async () => {
    if (done) return
    let configData: ConfigData
    try {
      const resp = await client.config.get({ throwOnError: true })
      configData = (resp.data ?? {}) as ConfigData
    } catch (err) {
      throw new Error(`opencode-partial-compact: refusing to operate — failed to verify Opencode config: ${String(err)}`)
    }

    if (configData.compaction?.auto !== false) {
      throw new Error(
        "opencode-partial-compact: refusing to operate — set compaction.auto=false in opencode.json. " +
        "Opencode schedules auto-compaction from the previous assistant token record before plugins can recompute the partial-compacted effective context.",
      )
    }

    const raw = configData.plugin ?? []
    const pluginList = raw.map(e => Array.isArray(e) ? e[0] : e)

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
    done = true
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
  debugLog(`Plugin server() initialised: enabled=${cfg.enabled} reminder_enabled=${cfg.reminder_enabled} reminder_interval_tokens=${cfg.reminder_interval_tokens}`)

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
    ? async (input: { sessionID?: string; model?: { limit?: { context?: number; input?: number; output?: number } } }, output: { system: string[] }) => {
        if (!input.sessionID) return
        await coexistenceCheck()
        debugLog(`System hook: session=${input.sessionID} ${modelLimitSnapshot(input.model)}`)
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
    config: async (input: ConfigData) => {
      disableNativeAutoCompactionWhenEnabled(input, cfg)
      debugLog(cfg.enabled
        ? "Set compaction.auto=false in merged Opencode config"
        : "Skipped native auto-compaction config change because plugin is disabled")
    },
    tool: {
      partial_compact: buildCompactTool(ctx.client, cfg),
      partial_compact_instructions: buildInstructionToolWithClient(ctx.client),
      partial_compact_current_session_message_ids: buildCurrentSessionMessageIDsToolWithClient(ctx.client),
    },
    "experimental.chat.messages.transform": wrappedHook,
    "experimental.chat.system.transform": wrappedSystemHook,
    "experimental.session.compacting": cfg.enabled
      ? nativeCompactionFallbackHook(coexistenceCheck)
      : async () => { /* no-op when disabled */ },
    "experimental.compaction.autocontinue": cfg.enabled
      ? async (input, output) => {
          disableNativeCompactionAutocontinue(input, output)
        }
      : async () => { /* no-op when disabled */ },
  }
}
