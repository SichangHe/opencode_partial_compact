# Open Questions — resolved

All v0 design choices are now locked. Historical record of how each
was decided.

## Round 1 (first email to user)

| ID | Question | Resolution |
|---|---|---|
| OQ-1 | Granularity: message vs part vs both | **Message-only** for v0. Drop part-level + dual support per Opus critique O3. |
| OQ-2 | Who writes the summary | **Agent inline**, as arg to `pc_compact`. |
| OQ-3 | Recovery API (peek + restore) | **Drop both.** Peek as designed defeats compaction (critique C1); restore is a guaranteed cache miss without payoff (O1). v0.1 may revisit. |
| OQ-4 | Cache strategy (unrestricted vs gated) | **Unrestricted with tool-description nudge.** Honest break-even table in `40-kv-cache-strategy.md`; no enforcement. |
| OQ-5 | Plugin-pure vs fork | **Plugin-pure.** Empirically validated. |
| OQ-6 | Visibility of IDs (tag injection) | **No tag injection in v0** (Q-C). Agent figures out IDs from inline summaries / tool descriptions. Re-evaluate in v0.1 if "compact-something-30-turns-ago" becomes a real need. |
| OQ-7 | Compact semantics (replace vs annotate) | **Replace.** Synthetic text part replaces the range. |
| OQ-8 | Tool-pair safety (reject vs auto-expand) | **Reject.** Per Opus critique C7, auto-expand can silently swallow assistant reasoning. v0.1 may add explicit-opt-in auto_expand arg. |
| OQ-9 | oh-my-openagent ordering | **Refuse to load if order is wrong.** Per Opus critique O6 — warn-on-misorder gets ignored. |
| OQ-10 | Naming | **`opencode-partial-compact`** for plugin id, npm name, config filename. |

## Round 2 (after Opus critique)

| ID | Question | Resolution |
|---|---|---|
| Q-A | Pivot to trivial v0 or keep richer design with critique fixes | **Pivot.** (Implicit approval via user's "the agent's instincts are right".) |
| Q-B | Persistence: piggyback CompactionPart vs sidecar | **Spike piggyback (timeboxed 1 hr); fallback sidecar.** See `50-persistence.md`. Spike in progress. |
| Q-C | Drop tag injection | **Drop entirely for v0.** |
| Q-D | Bun-only vs Node | **Bun-only.** Matches the ecosystem (Opencode, DCP, oh-my-openagent). |
| Q-E | Repo location | **Same repo (`/ssd1/sichangheagent/opencode_partial_compact/`), public-ready structure, publish later.** |

## Deferred to v0.1+

OQs the Opus critique surfaced that we acknowledge but don't address in
v0:

- OQ-11 (reward-hacking eval).
- OQ-12 (UX when `/compact` invalidates our records).
- OQ-13 (sub-agent interaction — currently disjoint, no plumbing).
- OQ-14 (interrupted-turn consistency).
- OQ-15 (model copying IDs into outputs — surface area minimised by
  dropping tag injection).
- OQ-16 (PartID/MessageID format upgrade path — handled by major
  version bump).
