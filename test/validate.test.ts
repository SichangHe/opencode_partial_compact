import { describe, it, expect } from "bun:test"
import { validateRange, validateRanges } from "../src/validate"
import type { WithParts, CompactionRecord } from "../src/validate"

const SID = "ses01TEST000000000000000"

function makeMsg(id: string, parts: WithParts["parts"] = []): WithParts {
  return { info: { id, sessionID: SID }, parts }
}

function textPart(id: string, msgID: string, text = "hello"): WithParts["parts"][number] {
  return { id, sessionID: SID, messageID: msgID, type: "text", text }
}

function syntheticPart(id: string, msgID: string): WithParts["parts"][number] {
  return Object.assign(
    { id, sessionID: SID, messageID: msgID, type: "text" as const, text: "[compacted]", synthetic: true },
    { source: "opencode-partial-compact" },
  )
}

function toolPartPending(id: string, msgID: string): WithParts["parts"][number] {
  return {
    id,
    sessionID: SID,
    messageID: msgID,
    type: "tool",
    callID: id,
    tool: "bash",
    state: { status: "pending", input: {}, raw: "" },
  } as unknown as WithParts["parts"][number]
}

function toolPartCompleted(id: string, msgID: string): WithParts["parts"][number] {
  return {
    id,
    sessionID: SID,
    messageID: msgID,
    type: "tool",
    callID: id,
    tool: "bash",
    state: { status: "completed", input: {}, output: "ok", title: "bash", metadata: {}, time: { start: 1, end: 2 } },
  } as unknown as WithParts["parts"][number]
}

const MSG1 = "msg01AAA"
const MSG2 = "msg01BBB"
const MSG3 = "msg01CCC"
const MSG4 = "msg01DDD"

describe("validateRange", () => {
  it("returns null for a valid single-message range", () => {
    const msgs = [makeMsg(MSG1, [textPart("p1", MSG1)]), makeMsg(MSG2)]
    expect(validateRange(MSG1, MSG1, msgs, [])).toBeNull()
  })

  it("returns null for a valid multi-message range", () => {
    const msgs = [makeMsg(MSG1), makeMsg(MSG2), makeMsg(MSG3)]
    expect(validateRange(MSG1, MSG2, msgs, [])).toBeNull()
  })

  it("not_found when from_message_id is unknown", () => {
    const msgs = [makeMsg(MSG2)]
    const err = validateRange("msg_UNKNOWN", MSG2, msgs, [])
    expect(err?.kind).toBe("not_found")
    expect((err as { id: string }).id).toBe("msg_UNKNOWN")
  })

  it("not_found when to_message_id is unknown", () => {
    const msgs = [makeMsg(MSG1)]
    const err = validateRange(MSG1, "msg_UNKNOWN", msgs, [])
    expect(err?.kind).toBe("not_found")
    expect((err as { id: string }).id).toBe("msg_UNKNOWN")
  })

  it("invalid_order when from is after to", () => {
    const msgs = [makeMsg(MSG1), makeMsg(MSG2)]
    const err = validateRange(MSG2, MSG1, msgs, [])
    expect(err?.kind).toBe("invalid_order")
    expect((err as { from_message_id: string }).from_message_id).toBe(MSG2)
    expect((err as { to_message_id: string }).to_message_id).toBe(MSG1)
  })

  it("overlaps when range intersects existing compaction record", () => {
    const msgs = [makeMsg(MSG1), makeMsg(MSG2), makeMsg(MSG3)]
    const records: CompactionRecord[] = [
      { from_message_id: MSG1, to_message_id: MSG2, summary: "x", created_at_iso: "" },
    ]
    const err = validateRange(MSG2, MSG3, msgs, records)
    expect(err?.kind).toBe("overlaps")
    expect((err as { from_message_id: string }).from_message_id).toBe(MSG1)
  })

  it("prior_compaction when range contains a synthetic part", () => {
    const msgs = [
      makeMsg(MSG1, [syntheticPart("sp1", MSG1)]),
      makeMsg(MSG2),
    ]
    const err = validateRange(MSG1, MSG2, msgs, [])
    expect(err?.kind).toBe("prior_compaction")
  })

  it("tool_pair_split at upper boundary when last message has pending tool", () => {
    const msgs = [
      makeMsg(MSG1, [toolPartPending("t1", MSG1)]),
      makeMsg(MSG2, [toolPartCompleted("t1", MSG2)]),
    ]
    const err = validateRange(MSG1, MSG1, msgs, [])
    expect(err?.kind).toBe("tool_pair_split")
    expect((err as { at: string }).at).toBe(MSG1)
    expect((err as { extend_to?: string }).extend_to).toBe(MSG2)
  })

  it("tool_pair_split at lower boundary when message before range has pending tool", () => {
    const msgs = [
      makeMsg(MSG1, [toolPartPending("t1", MSG1)]),
      makeMsg(MSG2, [toolPartCompleted("t1", MSG2)]),
      makeMsg(MSG3),
    ]
    const err = validateRange(MSG2, MSG3, msgs, [])
    expect(err?.kind).toBe("tool_pair_split")
    expect((err as { at: string }).at).toBe(MSG2)
    expect((err as { extend_from?: string }).extend_from).toBe(MSG1)
    expect((err as { start_after?: string }).start_after).toBe(MSG2)
  })

  it("no overlap when records are disjoint", () => {
    const msgs = [makeMsg(MSG1), makeMsg(MSG2), makeMsg(MSG3), makeMsg(MSG4)]
    const records: CompactionRecord[] = [
      { from_message_id: MSG1, to_message_id: MSG2, summary: "x", created_at_iso: "" },
    ]
    expect(validateRange(MSG3, MSG4, msgs, records)).toBeNull()
  })

  it("skips records whose IDs do not resolve in the current view", () => {
    const msgs = [makeMsg(MSG3), makeMsg(MSG4)]
    const records: CompactionRecord[] = [
      // MSG1 and MSG2 no longer in view (e.g. /compact ran)
      { from_message_id: MSG1, to_message_id: MSG2, summary: "x", created_at_iso: "" },
    ]
    expect(validateRange(MSG3, MSG4, msgs, records)).toBeNull()
  })
})

describe("validateRanges", () => {
  it("accepts multiple disjoint ranges", () => {
    const msgs = [makeMsg(MSG1), makeMsg(MSG2), makeMsg(MSG3), makeMsg(MSG4)]
    const result = validateRanges([
      { from_message_id: MSG1, to_message_id: MSG1, summary: "one" },
      { from_message_id: MSG3, to_message_id: MSG4, summary: "two" },
    ], msgs, [])

    expect(result.error).toBeNull()
    expect(result.ranges).toHaveLength(2)
    expect(result.ranges[1]?.n_messages_replaced).toBe(2)
  })

  it("rejects ranges that overlap each other", () => {
    const msgs = [makeMsg(MSG1), makeMsg(MSG2), makeMsg(MSG3)]
    const result = validateRanges([
      { from_message_id: MSG1, to_message_id: MSG2, summary: "one" },
      { from_message_id: MSG2, to_message_id: MSG3, summary: "two" },
    ], msgs, [])

    expect(result.error?.kind).toBe("overlaps_new")
  })

  it("rejects any range that overlaps an active record", () => {
    const msgs = [makeMsg(MSG1), makeMsg(MSG2), makeMsg(MSG3), makeMsg(MSG4)]
    const result = validateRanges([
      { from_message_id: MSG3, to_message_id: MSG4, summary: "new" },
    ], msgs, [{ from_message_id: MSG2, to_message_id: MSG3, summary: "old", created_at_iso: "" }])

    expect(result.error?.kind).toBe("overlaps")
  })
})
