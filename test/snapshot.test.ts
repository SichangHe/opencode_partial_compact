/**
 * F4 snapshot test — byte stability of the messages.transform hook.
 *
 * Builds a fixed 3-message in-memory fixture with one active compaction record,
 * runs the hook twice, and verifies the outputs are byte-identical.
 *
 * This test MUST pass before any change to hook.ts ships.
 */

import { describe, it, expect } from "bun:test"
import { applyCompactions, syntheticText, syntheticPartId } from "../src/hook"
import type { CompactionRecord } from "../src/validate"

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const SESSION_ID = "ses01TESTFIXTURE00000000"
const MSG_A = "msg01TESTFIXTURE0000001A"
const MSG_B = "msg01TESTFIXTURE0000002B"
const MSG_C = "msg01TESTFIXTURE0000003C"

function makeMessages() {
  return [
    {
      info: { id: MSG_A, sessionID: SESSION_ID },
      parts: [
        {
          id: "prt01A",
          sessionID: SESSION_ID,
          messageID: MSG_A,
          type: "text" as const,
          text: "User turn A",
        },
      ],
    },
    {
      info: { id: MSG_B, sessionID: SESSION_ID },
      parts: [
        {
          id: "prt01B",
          sessionID: SESSION_ID,
          messageID: MSG_B,
          type: "text" as const,
          text: "Assistant turn B — some long content",
        },
      ],
    },
    {
      info: { id: MSG_C, sessionID: SESSION_ID },
      parts: [
        {
          id: "prt01C",
          sessionID: SESSION_ID,
          messageID: MSG_C,
          type: "text" as const,
          text: "User turn C",
        },
      ],
    },
  ]
}

const RECORD: CompactionRecord = {
  from_message_id: MSG_A,
  to_message_id: MSG_B,
  summary: "Read files A and B — neither relevant.",
  created_at_iso: "2026-05-16T00:00:00.000Z",
}

// ---------------------------------------------------------------------------
// Expected output (hand-authored, this is the F4 invariant)
// ---------------------------------------------------------------------------

const EXPECTED_SYNTHETIC_TEXT =
  `[compacted: ${MSG_A}..${MSG_B} — Read files A and B — neither relevant.]`

const EXPECTED_PART_ID = `pc_${MSG_A}`

// The expected serialised message array after hook application:
//   - MSG_A survives with one synthetic text part
//   - MSG_B is removed
//   - MSG_C survives unchanged
const EXPECTED_JSON = JSON.stringify([
  {
    info: { id: MSG_A, sessionID: SESSION_ID },
    parts: [
      {
        id: EXPECTED_PART_ID,
        sessionID: SESSION_ID,
        messageID: MSG_A,
        type: "text",
        text: EXPECTED_SYNTHETIC_TEXT,
        synthetic: true,
        source: "opencode-partial-compact",
      },
    ],
  },
  {
    info: { id: MSG_C, sessionID: SESSION_ID },
    parts: [
      {
        id: "prt01C",
        sessionID: SESSION_ID,
        messageID: MSG_C,
        type: "text",
        text: "User turn C",
      },
    ],
  },
])

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("F4: hook output byte-stability", () => {
  it("syntheticText is deterministic", () => {
    expect(syntheticText(RECORD)).toBe(EXPECTED_SYNTHETIC_TEXT)
  })

  it("syntheticPartId is deterministic", () => {
    expect(syntheticPartId(RECORD)).toBe(EXPECTED_PART_ID)
  })

  it("applyCompactions produces byte-identical output on two separate runs", () => {
    const msgs1 = makeMessages()
    applyCompactions(msgs1, [RECORD])
    const json1 = JSON.stringify(msgs1)

    const msgs2 = makeMessages()
    applyCompactions(msgs2, [RECORD])
    const json2 = JSON.stringify(msgs2)

    expect(Buffer.from(json1).equals(Buffer.from(json2))).toBe(true)
  })

  it("applyCompactions output matches hand-authored expected fixture", () => {
    const msgs = makeMessages()
    applyCompactions(msgs, [RECORD])
    const actual = JSON.stringify(msgs)
    expect(actual).toBe(EXPECTED_JSON)
  })

  it("applyCompactions removes interior messages and keeps boundary messages", () => {
    const msgs = makeMessages()
    applyCompactions(msgs, [RECORD])
    // MSG_B (interior/last-in-range) is removed; MSG_A and MSG_C remain
    expect(msgs).toHaveLength(2)
    expect(msgs[0]?.info.id).toBe(MSG_A)
    expect(msgs[1]?.info.id).toBe(MSG_C)
  })

  it("the surviving first message has exactly one synthetic part", () => {
    const msgs = makeMessages()
    applyCompactions(msgs, [RECORD])
    const first = msgs[0]!
    expect(first.parts).toHaveLength(1)
    const part = first.parts[0]! as { type: string; text: string; synthetic: boolean; source: string }
    expect(part.type).toBe("text")
    expect(part.synthetic).toBe(true)
    expect(part.source).toBe("opencode-partial-compact")
    expect(part.text).toBe(EXPECTED_SYNTHETIC_TEXT)
  })
})
