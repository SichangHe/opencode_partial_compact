import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { nativeCompactionContext, sessionCompactingHandler } from "../src/compacting"
import { addCompaction, _clearCache, _setStorageDir } from "../src/state"

let tempDir: string
let storageRoot: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pc-compacting-test-"))
  storageRoot = join(tempDir, "plugin", "opencode-partial-compact")
  _setStorageDir(storageRoot)
  _clearCache()
})

afterEach(async () => {
  _setStorageDir(null)
  _clearCache()
  await rm(tempDir, { recursive: true, force: true })
})

describe("native compaction context", () => {
  it("returns null when no partial compactions exist", () => {
    expect(nativeCompactionContext([])).toBeNull()
  })

  it("formats partial compaction summaries for native compaction", () => {
    const context = nativeCompactionContext([{
      from_message_id: "msg01A",
      to_message_id: "msg01B",
      summary: "Kept durable fact paths and verifier outcomes.",
      created_at_iso: "",
    }])

    expect(context).toContain("Existing partial compactions from opencode-partial-compact:")
    expect(context).toContain("msg01A..msg01B")
    expect(context).toContain("Kept durable fact paths and verifier outcomes.")
  })

  it("appends sidecar summaries to the native compaction hook context", async () => {
    const sid = "ses01COMPACTING01"
    await addCompaction(sid, {
      from_message_id: "msg01A",
      to_message_id: "msg01B",
      summary: "A concise durable summary.",
      created_at_iso: "",
    })

    const output: { context: string[]; prompt?: string } = { context: [] }
    await sessionCompactingHandler({ sessionID: sid }, output)

    expect(output.context).toHaveLength(1)
    expect(output.context[0]).toContain("A concise durable summary.")
    expect(output.prompt).toBeUndefined()
  })
})
