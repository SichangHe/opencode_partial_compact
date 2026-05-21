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
| Compaction reminder cadence | `src/reminder.ts` |
| Sidecar persistence | `src/state.ts` |
| Range validation | `src/validate.ts` |

## Implemented behavior

- Agent tool is `partial_compact(from_message_id, to_message_id, summary)`.
- TUI registers `/partial_compact` and `/partial-compact` and emits a one-shot prompt that tells the agent to call `partial_compact` once with exact IDs.
- Successful tool calls append a sidecar record under `~/.local/share/opencode/storage/plugin/opencode-partial-compact/{sessionId}.json`.
- `experimental.chat.messages.transform` replaces each compacted range in the model-visible view with one synthetic text part. It does not mutate the SQLite log.
- `experimental.chat.system.transform` occasionally reminds the agent to consider `partial_compact` after estimated visible context growth.
- Native compaction receives no injected partial summaries; Opencode still runs `experimental.chat.messages.transform` before the native compaction model call, so it sees the collapsed view.
- After native compaction, stale sidecar records are pruned only when a native `compaction` part is visible and a full-session message lookup confirms both endpoints are gone.

## Known boundary

The plugin cannot rewrite a previous assistant message's already-recorded token usage. If Opencode schedules auto-compaction from that stale record, the plugin cannot cancel the scheduling through current public hooks. What is fixed here: every subsequent normal model call and native compaction model call uses the `messages.transform` output, i.e. the partial-compacted effective context.

## Validation

Current checks to run after edits:

```sh
bun test
bun run typecheck
bun run build
```

Recent verified state: run `bun test`, `bun run typecheck`, and `bun run build` after edits.

## Recent important decisions

- Rename model-facing tool from `pc_compact` to `partial_compact` for clarity; no alias is registered so the model sees one compaction tool.
- Keep sidecar persistence instead of piggybacking on Opencode `CompactionPart`; see [`50-persistence.md`](50-persistence.md).
- Do not inject partial summaries into native/full compaction prompts. Rely on `messages.transform` and prune stale sidecar records safely afterward.
- Add periodic reminders and stronger tool wording because agents otherwise under-use optional context-hygiene tools.

## Next likely work

- Consider surfacing stale-record/prune status in tool results or docs if users need observability.
- Re-check plugin peer dependency lower bound against installed Opencode plugin packages before publishing.
