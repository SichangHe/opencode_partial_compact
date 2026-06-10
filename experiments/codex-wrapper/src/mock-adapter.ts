import type { AgentAdapter, AgentToolCall, AgentTurnInput, AgentTurnOutput, VisibleEntry } from "./types.js"

export class MockCodexAdapter implements AgentAdapter {
  #phase: "discover" | "compact" | "continue" | "final" = "discover"

  async runTurn(input: AgentTurnInput): Promise<AgentTurnOutput> {
    switch (this.#phase) {
      case "discover":
        this.#phase = "compact"
        return {
          assistant_text: "I will inspect stale overview material first, then production configuration.",
          tool_calls: [
            { name: "read_file", args: { path: "README.md" } },
            { name: "read_file", args: { path: "logs/legacy-audit.txt" } },
            { name: "read_file", args: { path: "config/production.json" } },
          ],
        }
      case "compact": {
        this.#phase = "continue"
        const range = staleDiscoveryRange(input.visible_entries)
        const tool_calls: AgentToolCall[] = [{ name: "current_message_ids", args: {} }]
        if (range) {
          tool_calls.push({
            name: "partial_compact",
            args: {
              from_message_id: range.from_message_id,
              to_message_id: range.to_message_id,
              summary: "stale discovery: checked README and legacy staging audit log; both mention old 30000ms staging behavior and are not production evidence. Kept production config outside this compacted range.",
            },
          })
        }
        return {
          assistant_text: "The README and legacy audit log are stale. I will compact that discovery context before continuing.",
          tool_calls,
        }
      }
      case "continue":
        this.#phase = "final"
        assertCompactedContext(input.visible_context)
        return {
          assistant_text: "Compaction is active; the stale raw audit block is absent from my visible context. I will inspect the production error and code default.",
          tool_calls: [
            { name: "read_file", args: { path: "logs/prod-error.txt" } },
            { name: "read_file", args: { path: "src/payment-api.ts" } },
          ],
        }
      case "final":
        return {
          assistant_text: [
            "Diagnosis: production config sets `requestTimeoutMs` to 12000 while the upstream deadline is 9000.",
            "The production log shows the upstream closes around 9012ms before the app timeout fires.",
            "The code default is 8000, so the regression is the production override, not the code default.",
            "Recommended fix: set the production payment timeout below 9000ms, for example 8000ms.",
          ].join("\n"),
          tool_calls: [],
        }
    }
  }
}

function staleDiscoveryRange(entries: VisibleEntry[]): { from_message_id: string; to_message_id: string } | null {
  const first = entries.find(entry =>
    entry.kind === "message" && entry.message.text.includes("inspect stale overview material"),
  )
  let last: VisibleEntry | undefined
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry?.kind === "message" && entry.message.text.includes("STALE_LEGACY_AUDIT_BLOCK")) {
      last = entry
      break
    }
  }
  if (first?.kind !== "message" || last?.kind !== "message") return null
  return { from_message_id: first.message.id, to_message_id: last.message.id }
}

function assertCompactedContext(context: string): void {
  if (!context.includes("<compacted")) {
    throw new Error("expected compacted context before continuation")
  }
  if (context.includes("STALE_LEGACY_AUDIT_BLOCK")) {
    throw new Error("stale raw context leaked after compaction")
  }
}
