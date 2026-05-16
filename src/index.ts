import type { PluginModule } from "@opencode-ai/plugin"
import { server } from "./plugin.js"

const mod: PluginModule = {
  id: "opencode-partial-compact",
  server,
}

export default mod
