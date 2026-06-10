import type {
  CompactionRecord,
  LedgerMessage,
  MessageRole,
  PartialCompactArgs,
  PartialCompactResult,
  VisibleEntry,
} from "./types.js"

export class WrapperLedger {
  readonly session_id: string
  readonly messages: LedgerMessage[] = []
  readonly compactions: CompactionRecord[] = []
  #next_message_n = 1
  #next_compaction_n = 1

  constructor(session_id: string) {
    this.session_id = session_id
  }

  append(role: MessageRole, text: string, source?: string): LedgerMessage {
    const msg: LedgerMessage = {
      id: formatMessageId(this.#next_message_n),
      role,
      text,
      created_at_iso: new Date(0).toISOString(),
      ...(source === undefined ? {} : { source }),
    }
    this.#next_message_n += 1
    this.messages.push(msg)
    return msg
  }

  currentVisibleMessageIds(): string[] {
    return this.visibleEntries().flatMap(entry =>
      entry.kind === "message" ? [entry.message.id] : [entry.record.id],
    )
  }

  partialCompact(args: PartialCompactArgs): PartialCompactResult {
    const summary = args.summary.trim()
    if (summary.length === 0) return { ok: false, error: "summary must be non-empty" }

    const from_idx = this.messages.findIndex(msg => msg.id === args.from_message_id)
    if (from_idx === -1) return { ok: false, error: `from_message_id ${args.from_message_id} not found` }

    const to_idx = this.messages.findIndex(msg => msg.id === args.to_message_id)
    if (to_idx === -1) return { ok: false, error: `to_message_id ${args.to_message_id} not found` }
    if (from_idx > to_idx) {
      return { ok: false, error: `${args.from_message_id} comes after ${args.to_message_id}` }
    }

    for (const record of this.compactions) {
      const rec_from_idx = this.mustMessageIndex(record.from_message_id)
      const rec_to_idx = this.mustMessageIndex(record.to_message_id)
      if (from_idx <= rec_to_idx && to_idx >= rec_from_idx) {
        return { ok: false, error: `range overlaps compaction ${record.id}` }
      }
    }

    const record: CompactionRecord = {
      id: formatCompactionId(this.#next_compaction_n),
      from_message_id: args.from_message_id,
      to_message_id: args.to_message_id,
      summary,
      created_at_iso: new Date(0).toISOString(),
      n_messages_replaced: to_idx - from_idx + 1,
    }
    this.#next_compaction_n += 1
    this.compactions.push(record)
    return { ok: true, record, visible_message_ids: this.currentVisibleMessageIds() }
  }

  visibleEntries(): VisibleEntry[] {
    const entries: VisibleEntry[] = []
    let i = 0
    while (i < this.messages.length) {
      const record = this.compactions.find(compaction => compaction.from_message_id === this.messages[i]?.id)
      if (!record) {
        const message = this.messages[i]
        if (message) entries.push({ kind: "message", message })
        i += 1
        continue
      }
      entries.push({ kind: "compaction", record })
      i = this.mustMessageIndex(record.to_message_id) + 1
    }
    return entries
  }

  renderVisibleContext(system_instructions: string): string {
    const rendered = this.visibleEntries().map(entry => {
      if (entry.kind === "compaction") {
        return [
          `<compacted id="${entry.record.id}" range="${entry.record.from_message_id}..${entry.record.to_message_id}">`,
          entry.record.summary,
          "</compacted>",
        ].join("\n")
      }
      return [
        `<message id="${entry.message.id}" role="${entry.message.role}">`,
        entry.message.text,
        "</message>",
      ].join("\n")
    })
    return [`<system>${system_instructions}</system>`, ...rendered].join("\n\n")
  }

  snapshot(): unknown {
    return {
      schema_version: 1,
      session_id: this.session_id,
      messages: this.messages,
      compactions: this.compactions,
      visible_message_ids: this.currentVisibleMessageIds(),
    }
  }

  private mustMessageIndex(message_id: string): number {
    const idx = this.messages.findIndex(msg => msg.id === message_id)
    if (idx === -1) throw new Error(`message ${message_id} vanished from ledger`)
    return idx
  }
}

export function formatMessageId(n: number): string {
  return `msg${n.toString(36).toUpperCase().padStart(6, "0")}`
}

function formatCompactionId(n: number): string {
  return `cmp${n.toString(36).toUpperCase().padStart(6, "0")}`
}
