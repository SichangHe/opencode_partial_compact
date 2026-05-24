import { describe, expect, it } from "bun:test"
import {
  blockNativeCompaction,
  disableNativeAutoCompaction,
  disableNativeAutoCompactionWhenEnabled,
  disableNativeCompactionAutocontinue,
  NATIVE_COMPACTION_DISABLED_ERROR,
  makeCoexistenceCheck,
  normalizePluginConfig,
} from "../src/plugin"

function client(data: { plugin?: string[]; compaction?: { auto?: boolean } }) {
  return {
    config: {
      get: async () => ({ data }),
    },
  }
}

describe("plugin config guard", () => {
  it("forces native auto-compaction off in the merged config hook", () => {
    const data: { compaction?: { auto?: boolean; tail_turns?: number } } = {
      compaction: { auto: true, tail_turns: 15 },
    }

    disableNativeAutoCompaction(data)

    expect(data.compaction).toEqual({ auto: false, tail_turns: 15 })
  })

  it("creates compaction config when forcing native auto-compaction off", () => {
    const data: { compaction?: { auto?: boolean } } = {}

    disableNativeAutoCompaction(data)

    expect(data.compaction).toEqual({ auto: false })
  })

  it("does not force native auto-compaction off when the plugin is disabled", () => {
    const data: { compaction?: { auto?: boolean } } = { compaction: { auto: true } }

    disableNativeAutoCompactionWhenEnabled(data, { enabled: false })

    expect(data.compaction).toEqual({ auto: true })
  })

  it("forces native auto-compaction off when the plugin is enabled", () => {
    const data: { compaction?: { auto?: boolean } } = { compaction: { auto: true } }

    disableNativeAutoCompactionWhenEnabled(data, { enabled: true })

    expect(data.compaction).toEqual({ auto: false })
  })

  it("fails closed when native compaction starts", async () => {
    await expect(blockNativeCompaction({ sessionID: "ses_native" }))
      .rejects.toThrow(NATIVE_COMPACTION_DISABLED_ERROR)
  })

  it("disables native compaction auto-continue", () => {
    const output = { enabled: true }

    disableNativeCompactionAutocontinue({ sessionID: "ses_native", overflow: true }, output)

    expect(output.enabled).toBe(false)
  })

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
