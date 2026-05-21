import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { loadState, loadStateFresh, addCompaction, replaceCompactions, _clearCache, _setStorageDir } from "../src/state"

let tempDir: string
let storageRoot: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pc-state-test-"))
  storageRoot = join(tempDir, "plugin", "opencode-partial-compact")
  _setStorageDir(storageRoot)
  _clearCache()
})

afterEach(async () => {
  _setStorageDir(null)
  _clearCache()
  await rm(tempDir, { recursive: true, force: true })
})

describe("state round-trip", () => {
  it("loadState returns empty state when no sidecar exists", async () => {
    const state = await loadState("ses01ABCDE")
    expect(state.schema_version).toBe(1)
    expect(state.session_id).toBe("ses01ABCDE")
    expect(state.compactions).toHaveLength(0)
  })

  it("addCompaction persists to disk and is readable after cache clear", async () => {
    const sid = "ses01PERSIST01"
    await addCompaction(sid, {
      from_message_id: "msg01A",
      to_message_id: "msg01B",
      summary: "Test summary",
      created_at_iso: "2026-05-16T00:00:00.000Z",
    })

    // Clear in-memory cache and reload from disk
    _clearCache()
    const state = await loadState(sid)
    expect(state.compactions).toHaveLength(1)
    expect(state.compactions[0]?.from_message_id).toBe("msg01A")
    expect(state.compactions[0]?.summary).toBe("Test summary")
  })

  it("loadStateFresh refreshes a cached sidecar from disk", async () => {
    const sid = "ses01FRESH01"
    const cached = await loadState(sid)
    expect(cached.compactions).toHaveLength(0)

    await mkdir(storageRoot, { recursive: true })
    await writeFile(
      join(storageRoot, `${sid}.json`),
      JSON.stringify({
        schema_version: 1,
        session_id: sid,
        compactions: [{
          from_message_id: "msg01A",
          to_message_id: "msg01B",
          summary: "fresh",
          created_at_iso: "",
        }],
        last_written_iso: "",
      }),
      "utf8",
    )

    expect((await loadState(sid)).compactions).toHaveLength(0)
    expect((await loadStateFresh(sid)).compactions[0]?.summary).toBe("fresh")
  })

  it("multiple compactions are sorted by from_message_id", async () => {
    const sid = "ses01SORT01"
    // Insert in reverse order
    await addCompaction(sid, {
      from_message_id: "msg01CCC",
      to_message_id: "msg01DDD",
      summary: "C",
      created_at_iso: "",
    })
    await addCompaction(sid, {
      from_message_id: "msg01AAA",
      to_message_id: "msg01BBB",
      summary: "A",
      created_at_iso: "",
    })

    _clearCache()
    const state = await loadState(sid)
    expect(state.compactions[0]?.from_message_id).toBe("msg01AAA")
    expect(state.compactions[1]?.from_message_id).toBe("msg01CCC")
  })

  it("replaceCompactions persists a pruned sorted record set", async () => {
    const sid = "ses01REPLACE01"
    await addCompaction(sid, {
      from_message_id: "msg01CCC",
      to_message_id: "msg01DDD",
      summary: "remove me",
      created_at_iso: "",
    })
    await replaceCompactions(sid, [{
      from_message_id: "msg01AAA",
      to_message_id: "msg01BBB",
      summary: "keep me",
      created_at_iso: "",
    }])

    _clearCache()
    const state = await loadState(sid)
    expect(state.compactions).toHaveLength(1)
    expect(state.compactions[0]?.from_message_id).toBe("msg01AAA")
    expect(state.compactions[0]?.summary).toBe("keep me")
  })

  it("atomic write: tmp file is cleaned up on success", async () => {
    const sid = "ses01ATOMIC01"
    await addCompaction(sid, {
      from_message_id: "msg01A",
      to_message_id: "msg01B",
      summary: "atomic test",
      created_at_iso: "",
    })

    const tmpPath = join(storageRoot, `${sid}.json.tmp`)
    try {
      await readFile(tmpPath)
      expect(false).toBe(true) // tmp file should not exist after success
    } catch (err: unknown) {
      expect((err as { code?: string }).code).toBe("ENOENT")
    }
  })

  it("handles corrupted sidecar gracefully (backs up, returns empty)", async () => {
    const sid = "ses01CORRUPT01"
    await mkdir(storageRoot, { recursive: true })
    const filePath = join(storageRoot, `${sid}.json`)
    await writeFile(filePath, "NOT VALID JSON {{{", "utf8")

    const state = await loadState(sid)
    expect(state.compactions).toHaveLength(0)

    // Backup file should exist
    const files = await readdir(storageRoot)
    const badFiles = files.filter(f => f.startsWith(`${sid}.json.bad-`))
    expect(badFiles.length).toBeGreaterThan(0)
  })

  it("throws on schema_version > 1 (version skew)", async () => {
    const sid = "ses01SKEW01"
    await mkdir(storageRoot, { recursive: true })
    const filePath = join(storageRoot, `${sid}.json`)
    await writeFile(
      filePath,
      JSON.stringify({ schema_version: 99, session_id: sid, compactions: [], last_written_iso: "" }),
      "utf8",
    )

    try {
      await loadState(sid)
      expect(false).toBe(true) // should have thrown
    } catch (err: unknown) {
      expect((err as Error).message).toContain("schema_version=99")
    }
  })
})
