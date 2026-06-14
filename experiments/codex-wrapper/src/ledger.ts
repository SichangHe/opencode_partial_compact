import type {
  CompactionRecord,
  LedgerMessage,
  MessageRole,
  PartialCompactArgs,
  PartialCompactRange,
  PartialCompactRangesResult,
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
    const result = this.partialCompactRanges([args])
    if (!result.ok) return result
    const record = result.records[0]
    if (!record) return { ok: false, error: "no compaction record created" }
    return { ok: true, record, visible_message_ids: result.visible_message_ids }
  }

  partialCompactRanges(ranges: PartialCompactRange[]): PartialCompactRangesResult {
    if (ranges.length === 0) return { ok: false, error: "ranges must be non-empty" }
    const pending: Array<{ range: PartialCompactRange; from_idx: number; to_idx: number; summary: string }> = []

    for (const range of ranges) {
      const summary = range.summary.trim()
      if (summary.length === 0) return { ok: false, error: "summary must be non-empty" }

      const from_idx = this.messages.findIndex(msg => msg.id === range.from_message_id)
      if (from_idx === -1) return { ok: false, error: `from_message_id ${range.from_message_id} not found` }

      const to_idx = this.messages.findIndex(msg => msg.id === range.to_message_id)
      if (to_idx === -1) return { ok: false, error: `to_message_id ${range.to_message_id} not found` }
      if (from_idx > to_idx) {
        return { ok: false, error: `${range.from_message_id} comes after ${range.to_message_id}` }
      }

      for (const record of this.compactions) {
        const rec_from_idx = this.mustMessageIndex(record.from_message_id)
        const rec_to_idx = this.mustMessageIndex(record.to_message_id)
        if (from_idx <= rec_to_idx && to_idx >= rec_from_idx) {
          return { ok: false, error: `range overlaps compaction ${record.id}` }
        }
      }

      for (const prior of pending) {
        if (from_idx <= prior.to_idx && to_idx >= prior.from_idx) {
          return { ok: false, error: `range overlaps requested range ${prior.range.from_message_id}..${prior.range.to_message_id}` }
        }
      }

      pending.push({ range, from_idx, to_idx, summary })
    }

    const records: CompactionRecord[] = []
    for (const item of pending) {
      const record: CompactionRecord = {
        id: formatCompactionId(this.#next_compaction_n),
        from_message_id: item.range.from_message_id,
        to_message_id: item.range.to_message_id,
        summary: item.summary,
        created_at_iso: new Date(0).toISOString(),
        n_messages_replaced: item.to_idx - item.from_idx + 1,
      }
      this.#next_compaction_n += 1
      this.compactions.push(record)
      records.push(record)
    }

    return {
      ok: true,
      records,
      visible_message_ids: this.currentVisibleMessageIds(),
      n_ranges_compacted: records.length,
      n_messages_replaced: records.reduce((sum, record) => sum + record.n_messages_replaced, 0),
    }
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
