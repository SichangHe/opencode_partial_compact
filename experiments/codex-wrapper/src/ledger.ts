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

  static fromSnapshot(raw: unknown): WrapperLedger {
    if (!isRecord(raw)) throw new Error("ledger snapshot must be an object")
    if (raw.schema_version !== 1) throw new Error("ledger snapshot schema_version must be 1")
    if (typeof raw.session_id !== "string" || raw.session_id.trim().length === 0) {
      throw new Error("ledger snapshot session_id must be non-empty")
    }
    if (!Array.isArray(raw.messages)) throw new Error("ledger snapshot messages must be an array")
    if (!Array.isArray(raw.compactions)) throw new Error("ledger snapshot compactions must be an array")
    const ledger = new WrapperLedger(raw.session_id)
    const message_ids = new Set<string>()
    let max_message_n = 0
    for (const raw_message of raw.messages) {
      const message = parseLedgerMessage(raw_message)
      if (message_ids.has(message.id)) throw new Error(`duplicate message id ${message.id}`)
      message_ids.add(message.id)
      max_message_n = Math.max(max_message_n, parsePrefixedId(message.id, "msg"))
      ledger.messages.push(message)
    }
    const compaction_ids = new Set<string>()
    let max_compaction_n = 0
    for (const raw_compaction of raw.compactions) {
      const compaction = parseCompactionRecord(raw_compaction)
      if (compaction_ids.has(compaction.id)) throw new Error(`duplicate compaction id ${compaction.id}`)
      validateCompactionReferences(compaction, ledger.messages)
      compaction_ids.add(compaction.id)
      max_compaction_n = Math.max(max_compaction_n, parsePrefixedId(compaction.id, "cmp"))
      ledger.compactions.push(compaction)
    }
    validateCompactionOverlaps(ledger.compactions, ledger.messages)
    ledger.#next_message_n = max_message_n + 1
    ledger.#next_compaction_n = max_compaction_n + 1
    return ledger
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
    const pending: Array<{ range: PartialCompactRange; from_idx: number; to_idx: number; summary: string; covered_compaction_ids: string[] }> = []

    for (const range of ranges) {
      const summary = range.summary.trim()
      if (summary.length === 0) return { ok: false, error: "summary must be non-empty" }

      const from_idx = this.boundaryMessageIndex(range.from_message_id, "from_message_id", "from")
      if (typeof from_idx === "string") return { ok: false, error: from_idx }
      const to_idx = this.boundaryMessageIndex(range.to_message_id, "to_message_id", "to")
      if (typeof to_idx === "string") return { ok: false, error: to_idx }
      if (from_idx > to_idx) {
        return { ok: false, error: `${range.from_message_id} comes after ${range.to_message_id}` }
      }

      const covered_compaction_ids: string[] = []
      for (const record of this.compactions) {
        const rec_from_idx = this.mustMessageIndex(record.from_message_id)
        const rec_to_idx = this.mustMessageIndex(record.to_message_id)
        if (from_idx <= rec_to_idx && to_idx >= rec_from_idx) {
          if (from_idx <= rec_from_idx && rec_to_idx <= to_idx) {
            covered_compaction_ids.push(record.id)
            continue
          }
          return { ok: false, error: `range partially overlaps compaction ${record.id}; use the visible ${record.id} boundary or choose a non-overlapping range` }
        }
      }

      for (const prior of pending) {
        if (from_idx <= prior.to_idx && to_idx >= prior.from_idx) {
          return { ok: false, error: `range overlaps requested range ${prior.range.from_message_id}..${prior.range.to_message_id}` }
        }
      }

      pending.push({ range, from_idx, to_idx, summary, covered_compaction_ids })
    }

    const records: CompactionRecord[] = []
    const covered_compaction_ids = new Set(pending.flatMap(item => item.covered_compaction_ids))
    if (covered_compaction_ids.size > 0) {
      for (let i = this.compactions.length - 1; i >= 0; i -= 1) {
        if (covered_compaction_ids.has(this.compactions[i]?.id ?? "")) this.compactions.splice(i, 1)
      }
    }
    for (const item of pending) {
      const record: CompactionRecord = {
        id: formatCompactionId(this.#next_compaction_n),
        from_message_id: this.messages[item.from_idx]?.id ?? item.range.from_message_id,
        to_message_id: this.messages[item.to_idx]?.id ?? item.range.to_message_id,
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
          entry.record.summary,
          `<pcodx-compacted id="${entry.record.id}" range="${entry.record.from_message_id}..${entry.record.to_message_id}" />`,
        ].join("\n")
      }
      return [
        entry.message.text,
        `<aboveturn id="${entry.message.id}"/>`,
      ].join("\n")
    })
    return [system_instructions, ...rendered].join("\n\n")
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

  private boundaryMessageIndex(id: string, field: string, side: "from" | "to"): number | string {
    const msg_idx = this.messages.findIndex(msg => msg.id === id)
    if (msg_idx !== -1) return msg_idx
    const record = this.compactions.find(compaction => compaction.id === id)
    if (!record) return `${field} ${id} not found`
    return this.mustMessageIndex(side === "from" ? record.from_message_id : record.to_message_id)
  }
}

export function formatMessageId(n: number): string {
  return `msg${n.toString(36).toUpperCase()}`
}

function formatCompactionId(n: number): string {
  return `cmp${n.toString(36).toUpperCase()}`
}

function parseLedgerMessage(raw: unknown): LedgerMessage {
  if (!isRecord(raw)) throw new Error("ledger message must be an object")
  if (typeof raw.id !== "string") throw new Error("ledger message id must be a string")
  parsePrefixedId(raw.id, "msg")
  if (!isMessageRole(raw.role)) throw new Error("ledger message role is invalid")
  if (typeof raw.text !== "string") throw new Error("ledger message text must be a string")
  if (typeof raw.created_at_iso !== "string") throw new Error("ledger message created_at_iso must be a string")
  if (raw.source !== undefined && typeof raw.source !== "string") throw new Error("ledger message source must be a string")
  return {
    id: raw.id,
    role: raw.role,
    text: raw.text,
    created_at_iso: raw.created_at_iso,
    ...(raw.source === undefined ? {} : { source: raw.source }),
  }
}

function parseCompactionRecord(raw: unknown): CompactionRecord {
  if (!isRecord(raw)) throw new Error("compaction record must be an object")
  if (typeof raw.id !== "string") throw new Error("compaction id must be a string")
  parsePrefixedId(raw.id, "cmp")
  if (typeof raw.from_message_id !== "string") throw new Error("compaction from_message_id must be a string")
  if (typeof raw.to_message_id !== "string") throw new Error("compaction to_message_id must be a string")
  if (typeof raw.summary !== "string") throw new Error("compaction summary must be a string")
  if (typeof raw.created_at_iso !== "string") throw new Error("compaction created_at_iso must be a string")
  if (typeof raw.n_messages_replaced !== "number") throw new Error("compaction n_messages_replaced must be a number")
  return {
    id: raw.id,
    from_message_id: raw.from_message_id,
    to_message_id: raw.to_message_id,
    summary: raw.summary,
    created_at_iso: raw.created_at_iso,
    n_messages_replaced: raw.n_messages_replaced,
  }
}

function validateCompactionReferences(record: CompactionRecord, messages: LedgerMessage[]): void {
  const from_idx = messages.findIndex(message => message.id === record.from_message_id)
  if (from_idx === -1) throw new Error(`compaction ${record.id} references missing from_message_id ${record.from_message_id}`)
  const to_idx = messages.findIndex(message => message.id === record.to_message_id)
  if (to_idx === -1) throw new Error(`compaction ${record.id} references missing to_message_id ${record.to_message_id}`)
  if (from_idx > to_idx) throw new Error(`compaction ${record.id} range is reversed`)
  const expected_n = to_idx - from_idx + 1
  if (record.n_messages_replaced !== expected_n) {
    throw new Error(`compaction ${record.id} n_messages_replaced must be ${expected_n}`)
  }
}

function validateCompactionOverlaps(records: CompactionRecord[], messages: LedgerMessage[]): void {
  const ranges = records.map(record => ({
    id: record.id,
    from_idx: messages.findIndex(message => message.id === record.from_message_id),
    to_idx: messages.findIndex(message => message.id === record.to_message_id),
  }))
  for (let i = 0; i < ranges.length; i += 1) {
    const current = ranges[i]
    if (!current) continue
    for (let j = i + 1; j < ranges.length; j += 1) {
      const next = ranges[j]
      if (!next) continue
      if (current.from_idx <= next.to_idx && current.to_idx >= next.from_idx) {
        throw new Error(`compaction ${current.id} overlaps compaction ${next.id}`)
      }
    }
  }
}

function parsePrefixedId(id: string, prefix: "msg" | "cmp"): number {
  if (!id.startsWith(prefix)) throw new Error(`invalid ${prefix} id ${id}`)
  const suffix = id.slice(prefix.length)
  if (!/^[0-9A-Z]+$/.test(suffix)) throw new Error(`invalid ${prefix} id ${id}`)
  const n = Number.parseInt(suffix, 36)
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`invalid ${prefix} id ${id}`)
  return n
}

function isMessageRole(value: unknown): value is MessageRole {
  return value === "system" || value === "user" || value === "assistant" || value === "tool"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
