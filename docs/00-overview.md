# Overview (v0 spec)

Agent-driven partial context compaction for Opencode, shipped as
a single plugin.
v0 is deliberately minimal;
see [`02-critique-findings.md`](02-critique-findings.md) for the bugs in
the v1 draft and why we cut scope.

## What the agent can do

Three tools:

```text
partial_compact(ranges: [{ from_message_id, to_message_id, summary }, ...])
partial_compact_instructions() -> instruction block "opencode-partial-compact"
partial_compact_current_session_message_ids() -> ordered visible current-session msg... IDs
```

`partial_compact` replaces a contiguous range of
past current-session messages (inclusive on both ends), or
multiple disjoint current-session ranges in one batch call, with
synthetic text parts containing the agent-written summaries.
The tool always operates on the active conversation's message ranges.
Originals stay in Opencode's `PartTable` untouched.
There is no `pc_peek`, `pc_restore`, or `pc_list` in v0.

## Why this works

- Opencode's `experimental.chat.messages.transform`
    hook gives plugins a mutable reference to
    the in-memory message array right before it becomes wire format.
    Originally verified in Opencode 1.14.46
    (POC at [`../experiments/poc/`](../experiments/poc/));
    current hook names are checked against the installed 1.15.x plugin/SDK
    types.
- Opencode already has monotonic `MessageID`s (`msg<26-char base62>`)
    generated in `id/id.ts`.
    Stable, totally ordered, reusable as turn IDs with no extra machinery.
- Originals are never destroyed by us: SQLite is the log layer.
    Our hook only rewrites the in-memory view per call.

## Cache cost (honest)

- Compactions in the **tail region** (≤ last ~2 messages,
    near Anthropic's last-2-non-system cache breakpoint) are nearly free:
    the breakpoint moves with us. Break-even: 1 turn.
- Compactions in the **middle of history** invalidate the cached prefix from
    the system breakpoint forward.
    Break-even for a 5k compaction in a 50k context: ~11 turns.
    Math in [`40-kv-cache-strategy.md`](40-kv-cache-strategy.md).

The tool description nudges the agent toward the cheap case but
does not enforce it.
Future v0.1 may annotate the tool result with an estimated break-even.

## Coexistence

- **Refuse to load** if `@tarquinen/opencode-dcp` is in the resolved
    plugin list. Both rewrite the message array; running both produces
    conflicting ID semantics. Error message points users at docs.
- **Refuse to load** if `oh-my-openagent` is listed before us. Our
    compactions must run before its `toolPairValidator` and synthetic
    turn injectors. See [`60-coexistence.md`](60-coexistence.md).

## Persistence and native compaction

State is a JSON sidecar at
`~/.local/share/opencode/storage/plugin/opencode-partial-compact/{sessionId}.json`.
The hook rewrites only the model-visible in-memory view;
the SQLite log remains untouched.

Native Opencode auto-compaction is disabled while this plugin is enabled:
`compaction.auto=false` is enforced in the merged config.
If Opencode still reaches `experimental.session.compacting` near overflow,
the plugin allows that native fallback so the session compacts rather than
stops. We do not append partial summaries to full-compaction prompts.
If a session contains native compaction parts,
stale sidecar records are pruned only after the full session message list
confirms both range endpoints are gone.
See [`50-persistence.md`](50-persistence.md).

Agents also get a periodic `experimental.chat.system.transform` reminder when
the estimated visible context grows by `reminder_interval_tokens` since
the last reminder. Default: 16k tokens.
Because this plugin disables native auto-compaction in
the merged runtime config,
the reminder is a mandatory context-management prompt:
it injects only a compact status line such as `current context window: 42k
(37% full)`.
The 16k setting is the target cadence; if
a known effective budget is smaller than the target, the runtime clamps to
an internal ~80% safety interval so reminders can still fire before exhaustion.
Agents can fetch the full named `opencode-partial-compact` instruction through
`partial_compact_instructions` and current visible endpoints through
`partial_compact_current_session_message_ids`.

## Bun, ESM, public-ready, in this repo

- Build: bun. Runtime: bun (Opencode bundles bun).
- `package.json`: `type: "module"`, package exports for server and TUI,
    `peerDependencies` on `@opencode-ai/plugin` and `@opencode-ai/sdk`.
- Repo layout suitable for `bun publish` later.
    License + README at top level when we publish.

## Doc index

| Doc                        | Topic                                                     | Status       |
| -------------------------- | --------------------------------------------------------- | ------------ |
| 00 (this)                  | What and why.                                             | v0           |
| 01-open-questions.md       | OQs A..E — all resolved.                                  | Resolved.    |
| 02-critique-findings.md    | Opus max critique that drove the v0 cut.                  | Historical.  |
| 10-turn-log-model.md       | IDs, log vs view, compaction record.                      | v0           |
| 20-agent-tools.md          | The `partial_compact` tool API.                           | v0           |
| 30-opencode-integration.md | Hook surface, plugin shape.                               | v0           |
| 40-kv-cache-strategy.md    | Corrected cache math.                                     | v0           |
| 50-persistence.md          | Sidecar persistence and native compaction reconciliation. | Implemented. |
| 60-coexistence.md          | DCP + oh-my-openagent rules.                              | v0           |
| 70-failure-modes.md        | F-codes still in scope.                                   | v0           |
| 80-maintainer-handoff.md   | Current implementation map and pickup checklist.          | Current      |
