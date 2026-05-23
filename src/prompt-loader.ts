import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "prompts")

export function loadPrompt(name: string): string {
  return readFileSync(join(promptsDir, name), "utf8").trim()
}

export function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => values[key] ?? match)
}
