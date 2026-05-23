import { describe, expect, it } from "bun:test"
import { makeCoexistenceCheck, normalizePluginConfig } from "../src/plugin"

function client(data: { plugin?: string[]; compaction?: { auto?: boolean } }) {
  return {
    config: {
      get: async () => ({ data }),
    },
  }
}

describe("plugin config guard", () => {
  it("rejects when native auto-compaction is not disabled", async () => {
    await expect(makeCoexistenceCheck(client({ plugin: ["opencode-partial-compact"] }))())
      .rejects.toThrow("set compaction.auto=false")
  })

  it("accepts when native auto-compaction is disabled", async () => {
    await expect(makeCoexistenceCheck(client({
      plugin: ["opencode-partial-compact"],
      compaction: { auto: false },
    }))()).resolves.toBeUndefined()
  })

  it("does not cache a failed config guard", async () => {
    let data: { plugin?: string[]; compaction?: { auto?: boolean } } = {
      plugin: ["opencode-partial-compact"],
    }
    const check = makeCoexistenceCheck({
      config: {
        get: async () => ({ data }),
      },
    })

    await expect(check()).rejects.toThrow("set compaction.auto=false")

    data = { plugin: ["opencode-partial-compact"], compaction: { auto: false } }
    await expect(check()).resolves.toBeUndefined()
  })

  it("does not cache a failed config fetch", async () => {
    let calls = 0
    const check = makeCoexistenceCheck({
      config: {
        get: async () => {
          calls += 1
          if (calls === 1) throw new Error("temporary config failure")
          return { data: { plugin: ["opencode-partial-compact"], compaction: { auto: false } } }
        },
      },
    })

    await expect(check()).rejects.toThrow("failed to verify Opencode config")
    await expect(check()).resolves.toBeUndefined()
  })
})

describe("plugin config normalization", () => {
  it("preserves explicit reminder_interval_tokens", () => {
    const cfg = normalizePluginConfig({ reminder_interval_tokens: 12345 })

    expect(cfg.reminder_interval_tokens).toBe(12345)
  })

  it("migrates deprecated reminder cadence keys", () => {
    const cfg = normalizePluginConfig({
      reminder_context_fraction: 0.1,
      reminder_min_tokens: 4000,
    })

    expect(cfg.reminder_interval_tokens).toBe(4000)
  })
})
