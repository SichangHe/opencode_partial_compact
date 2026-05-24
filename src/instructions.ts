import { loadPrompt, renderPrompt } from "./prompt-loader.js"

export const PARTIAL_COMPACT_INSTRUCTION_NAME = "opencode-partial-compact"

export function partialCompactInstructionBlock(): string {
  return loadPrompt("partial-compact-instruction.md")
}

export function partialCompactInstructionPointer(): string {
  return renderPrompt(loadPrompt("partial-compact-instruction-pointer.md"), {})
}
