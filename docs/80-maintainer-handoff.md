# Maintainer Handoff

This is the durable pickup map for the current implementation.

## Start here

- [`README.md`](../README.md) — install, config, and dev commands.
- [`docs/README.md`](README.md) — documentation read order.
- [`00-overview.md`](00-overview.md) — architecture in one page.
- [`30-opencode-integration.md`](30-opencode-integration.md) — plugin entrypoints and hook flow.
- [`50-persistence.md`](50-persistence.md) — sidecar schema and native compaction reconciliation.
- [`20-agent-tools.md`](20-agent-tools.md) — exact agent-facing tool contract.

## Current implementation map

| Concern | File |
|---|---|
| Server plugin registration | `src/plugin.ts` |
| Agent tool schema and instruction | `src/tool.ts` |
| TUI slash command | `src/tui.ts` |
| TUI checkpoint prompt | `src/tui-checkpoints.ts` |
| Message-view rewrite | `src/hook.ts` |
| Native compaction context | `src/compacting.ts` |
| Sidecar persistence | `src/state.ts` |
| Range validation | `src/validate.ts` |

## Implemented behavior

- Agent tool is `partial_compact(from_message_id, to_message_id, summary)`.
- TUI registers `/partial_compact` and `/partial-compact` and emits a one-shot prompt that tells the agent to call `partial_compact` once with exact IDs.
- Successful tool calls append a sidecar record under `~/.local/share/opencode/storage/plugin/opencode-partial-compact/{sessionId}.json`.
- `experimental.chat.messages.transform` replaces each compacted range in the model-visible view with one synthetic text part. It does not mutate the SQLite log.
- `experimental.session.compacting` appends active partial summaries to Opencode's native compaction prompt context.
- After native compaction, stale sidecar records are pruned only when a native `compaction` part is visible and a full-session message lookup confirms both endpoints are gone.

## Known boundary

The plugin cannot change Opencode's native auto-compaction trigger threshold through public plugin APIs. It can only change what native compaction sees and keep plugin sidecar state consistent afterward.

## Validation

Current checks to run after edits:

```sh
bun test
bun run typecheck
bun run build
```

Recent verified state: 36 tests passed, typecheck passed, build passed, and a runtime `/experimental/tool/ids` smoke check exposed `partial_compact` and not `pc_compact`.

## Recent important decisions

- Rename model-facing tool from `pc_compact` to `partial_compact` for clarity; no alias is registered so the model sees one compaction tool.
- Keep sidecar persistence instead of piggybacking on Opencode `CompactionPart`; see [`50-persistence.md`](50-persistence.md).
- Use plugin-only mitigation for native compaction: `experimental.session.compacting` context plus safe sidecar pruning. Core trigger accounting remains out of plugin scope.

## Next likely work

- Add an optional cap for how many partial summaries are injected into native compaction context if real sessions accumulate many records.
- Consider surfacing stale-record/prune status in tool results or docs if users need observability.
- Re-check plugin peer dependency lower bound against installed Opencode plugin packages before publishing.
