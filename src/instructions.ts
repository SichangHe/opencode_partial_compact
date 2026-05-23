import { loadPrompt, renderPrompt } from "./prompt-loader.js"

export const PARTIAL_COMPACT_INSTRUCTION_NAME = "opencode-partial-compact"

const instructionValues = {
  INSTRUCTION_NAME: PARTIAL_COMPACT_INSTRUCTION_NAME,
}

export function partialCompactInstructionBlock(): string {
  return renderPrompt(loadPrompt("partial-compact-instruction.md"), instructionValues)
}

export function partialCompactReminderExcerpt(): string {
  return loadPrompt("partial-compact-reminder-excerpt.md").replace(/\n+/g, " ")
}

export function partialCompactInstructionPointer(): string {
  return renderPrompt(loadPrompt("partial-compact-instruction-pointer.md"), instructionValues)
}
