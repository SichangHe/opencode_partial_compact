import { describe, expect, it } from "bun:test"
import { WrapperLedger } from "../src/ledger.js"
import { runDemo } from "../src/demo.js"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

describe("WrapperLedger", () => {
  it("injects message ids and replaces compacted ranges with summaries", () => {
    const ledger = new WrapperLedger("test-session")
    ledger.append("user", "task")
    const first = ledger.append("assistant", "old exploration")
    const second = ledger.append("tool", "raw stale output")
    ledger.append("assistant", "new useful work")

    const result = ledger.partialCompact({
      from_message_id: first.id,
      to_message_id: second.id,
      summary: "old exploration summary",
    })

    expect(result.ok).toBe(true)
    const context = ledger.renderVisibleContext("system")
    expect(context).toContain(`<message id="msg000001" role="user">`)
    expect(context).toContain(`<compacted id="cmp000001" range="${first.id}..${second.id}">`)
    expect(context).toContain("old exploration summary")
    expect(context).not.toContain("raw stale output")
  })

  it("rejects overlapping ranges", () => {
    const ledger = new WrapperLedger("test-session")
    const first = ledger.append("user", "one")
    const second = ledger.append("assistant", "two")
    const third = ledger.append("tool", "three")
    expect(ledger.partialCompact({
      from_message_id: first.id,
      to_message_id: second.id,
      summary: "summary",
    }).ok).toBe(true)

    const result = ledger.partialCompact({
      from_message_id: second.id,
      to_message_id: third.id,
      summary: "overlap",
    })
    expect(result.ok).toBe(false)
  })
})

describe("demo", () => {
  it("continues after partial compaction and writes receipts", async () => {
    await runDemo()
    const before = await readFile(join(ROOT, "runs", "latest", "visible-before-compaction.txt"), "utf8")
    const after = await readFile(join(ROOT, "runs", "latest", "visible-after-compaction.txt"), "utf8")
    const finalReport = await readFile(join(ROOT, "runs", "latest", "final-report.md"), "utf8")

    expect(before).toContain("STALE_LEGACY_AUDIT_BLOCK")
    expect(after).toContain("<compacted")
    expect(after).toContain("codex app-server curated-context injection probe: ok")
    expect(after).not.toContain("STALE_LEGACY_AUDIT_BLOCK")
    expect(finalReport).toContain("production config sets `requestTimeoutMs` to 12000")
    expect(finalReport).toContain("Recommended fix")
  })
})
