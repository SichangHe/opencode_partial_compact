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
| Agent tool schema | `src/tool.ts` |
| Prompt Markdown source files | `src/prompts/*.md` |
| Prompt loading/rendering | `src/prompt-loader.ts`, `src/instructions.ts` |
| TUI slash command | `src/tui.ts` |
| TUI checkpoint prompt | `src/tui-checkpoints.ts` |
| Message-view rewrite | `src/hook.ts` |
| Compaction reminder cadence | `src/reminder.ts` |
| Sidecar persistence | `src/state.ts` |
| Range validation | `src/validate.ts` |

## Implemented behavior

- Agent tools are `partial_compact` and `partial_compact_instructions`. `partial_compact` accepts current-session message ranges: `ranges: [{ from_message_id, to_message_id, summary }]`. The instruction tool appends ordered current-session `msg...` IDs for range selection.
- TUI registers `/partial_compact` and `/partial-compact` and emits a one-shot prompt with the full `opencode-partial-compact` instruction block, exact selected IDs, and guidance to use one `ranges` call if additional disjoint stale ranges are found.
- Successful tool calls append a sidecar record under `~/.local/share/opencode/storage/plugin/opencode-partial-compact/{sessionId}.json`.
- `experimental.chat.messages.transform` replaces each compacted range in the model-visible view with one synthetic text part. It does not mutate the SQLite log.
- `experimental.chat.system.transform` injects a mandatory `partial_compact` reminder after estimated visible context growth. It reports visible-token usage, includes context-window percentage when model limits are available, points to the named instruction, appends ordered current-session `msg...` IDs, and tells the agent to target staying under 50% visible context by compacting stale context that is not very likely to be useful soon. The configured 16k interval is the target cadence; known smaller effective input/context budgets clamp to an internal ~80% safety interval.
- Successful `partial_compact` calls immediately update `last_reminder.visible_token_estimate` to the post-compaction visible-token estimate so reminders do not fire again merely because a compaction just happened.
- Native auto-compaction is disabled with `compaction.auto=false`; if a native compaction path still starts near overflow, `experimental.session.compacting` allows it as a recovery fallback, `experimental.compaction.autocontinue` keeps continuation enabled for overflow recovery and disables it otherwise, and later transforms reconcile visible native compaction parts.
- After native compaction, stale sidecar records are pruned only when a native `compaction` part is visible and a full-session message lookup confirms both endpoints are gone.

## Known boundary

The plugin cannot rewrite a previous assistant message's already-recorded token usage. Opencode checks that record before plugins can recompute the partial-compacted effective context. To avoid stale-trigger native compactions when the visible context is already small, the plugin enforces `compaction.auto=false` in Opencode's merged runtime config. Every subsequent normal model call uses the `messages.transform` output, i.e. the partial-compacted effective context. If Opencode still reaches native compaction near overflow, the plugin allows it as a last-resort recovery path instead of throwing and stopping the session.

## Validation

Current checks to run after edits:

```sh
bun test
bun run typecheck
bun run build
```

After `bun run build`, reload the Opencode process that loaded this plugin before judging live tool/schema behavior.

## Recent important decisions

- Rename model-facing tool from `pc_compact` to `partial_compact` for clarity; no alias is registered so the model sees one compaction tool.
- Keep sidecar persistence instead of piggybacking on Opencode `CompactionPart`; see [`50-persistence.md`](50-persistence.md).
- Do not inject partial summaries into native/full compaction prompts. Rely on `messages.transform` and prune stale sidecar records safely afterward.
- Add mandatory periodic reminders and stronger tool wording because native auto-compaction is disabled and agents otherwise under-use optional context-hygiene tools.
- Add the named `opencode-partial-compact` instruction behind a read-only tool because Opencode plugin 1.15.x exposes tools/hooks, not first-class skill/resource registration.

## Next likely work

- Consider surfacing stale-record/prune status in tool results or docs if users need observability.
- Re-check plugin peer dependency lower bound against installed Opencode plugin packages before publishing.
