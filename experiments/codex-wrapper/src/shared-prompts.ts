import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SHARED_PROMPTS_DIR = join(ROOT, "..", "..", "src", "prompts")

export function loadSharedPrompt(name: string): string {
  return readFileSync(join(SHARED_PROMPTS_DIR, name), "utf8").trim()
}

export function renderSharedPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => values[key] ?? match)
}
