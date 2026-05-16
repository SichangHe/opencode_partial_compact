/**
 * opencode-partial-compact POC
 *
 * E1: Registers a tool called `pc_demo` (one string arg, returns a fixed string).
 * E2: Registers `experimental.chat.messages.transform` that logs messages.length
 *     and appends a sentinel TextPart to the last message's parts array.
 */

import { appendFileSync } from "node:fs"
import type { PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

const LOG_FILE = "/tmp/pc-poc.log"

function log(msg: string): void {
  const line = `[pc-poc ${new Date().toISOString()}] ${msg}\n`
  console.log(line.trim())
  try {
    appendFileSync(LOG_FILE, line)
  } catch {
    // best-effort; /tmp should always be writable
  }
}

const module_: PluginModule = {
  id: "opencode-partial-compact-poc",
  server: async (_ctx) => {
    log("Plugin server() called — initialising pc-poc")

    return {
      // ------------------------------------------------------------------ E1
      tool: {
        pc_demo: tool({
          description: "POC demo tool. Returns a fixed greeting string.",
          args: {
            message: tool.schema.string().describe("Any string — will be echoed back."),
          },
          async execute(args) {
            log(`pc_demo executed with message="${args.message}"`)
            return `pc-poc received: "${args.message}"`
          },
        }),
      },

      // ------------------------------------------------------------------ E2
      "experimental.chat.messages.transform": async (_input, output) => {
        const count = output.messages.length
        log(`messages.transform fired — messages.length=${count}`)

        if (count === 0) {
          return
        }

        // Append a sentinel TextPart to the last message's parts array.
        // TextPart requires id, sessionID, messageID — we synthesise them from
        // the last message's info to keep the mutation structurally valid.
        const last = output.messages[count - 1]
        const sentinelPart = {
          id: "pc-poc-sentinel",
          sessionID: last.info.sessionID,
          messageID: last.info.id,
          type: "text" as const,
          text: "<pc-poc-was-here>",
          synthetic: true,
        }

        last.parts.push(sentinelPart)
        log(`Appended sentinel TextPart to message ${last.info.id}`)
      },
    }
  },
}

export default module_
