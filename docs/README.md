# `opencode-partial-compact` — v0 design

Agent-driven partial context compaction for Opencode, as a single
plugin. One tool (`partial_compact`), no peek/restore/list, no tag
injection, mutual-exclusion with DCP. v0 is deliberately minimal; the
richer design that preceded it had a silent-failure bug in `pc_peek`
that drove the cut. Empirically validated against Opencode 1.14.46.

## Read order

1. [`00-overview.md`](00-overview.md) — what and why.
2. [`10-turn-log-model.md`](10-turn-log-model.md) — log vs view layers.
3. [`20-agent-tools.md`](20-agent-tools.md) — the `partial_compact` tool.
4. [`30-opencode-integration.md`](30-opencode-integration.md) — package
   shape, hook surface, install path.
5. [`50-persistence.md`](50-persistence.md) — sidecar storage, native-compaction reconciliation.
6. [`40-kv-cache-strategy.md`](40-kv-cache-strategy.md) — corrected
   cache math.
7. [`60-coexistence.md`](60-coexistence.md) — DCP refuse-to-load,
   oh-my-openagent ordering enforcement.
8. [`70-failure-modes.md`](70-failure-modes.md) — F-codes still in
   scope.
9. [`80-maintainer-handoff.md`](80-maintainer-handoff.md) — current implementation map and pickup checklist.

## Historical / reference

- [`01-open-questions.md`](01-open-questions.md) — OQs and Qs, all
  resolved for v0.
- [`02-critique-findings.md`](02-critique-findings.md) — Opus max
  review that drove the scope cut.

## Validation status

- POC at [`../experiments/poc/`](../experiments/poc/) — registers a
  tool and a `messages.transform` hook. **Successfully run inside
  Opencode 1.14.46:** hook fires, mutation persists into wire format,
  tool visible to the model. `/tmp/pc-poc.log` shows the run.
- Plugin loader (Opencode v1.14.46 binary, string-line 215730) uses
  `Bun.resolve()` and accepts `file://` URIs — no npm publish required
  for local use.

## Implementation status

Implemented and locally verified. Core runtime surfaces:

- Server plugin: `src/plugin.ts` registers `partial_compact`,
  `experimental.chat.messages.transform`, and
  `experimental.session.compacting`.
- TUI plugin: `src/tui.ts` registers `/partial_compact` and
  `/partial-compact`.
- Sidecar state: `src/state.ts`; view rewrite and stale-record
  reconciliation: `src/hook.ts`; native compaction context:
  `src/compacting.ts`.
- Current pickup checklist lives in
  [`80-maintainer-handoff.md`](80-maintainer-handoff.md).
