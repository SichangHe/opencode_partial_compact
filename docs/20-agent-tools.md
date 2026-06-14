# Agent Tools (v0)

Three tools.
`partial_compact` matches the user-facing slash command while
remaining clear of oh-my-openagent and Opencode built-ins.
`partial_compact_instructions`
returns the named instruction block `opencode-partial-compact`;
agents should read it before calling `partial_compact` if it is not already in
the context window.
`partial_compact_current_session_message_ids`
returns the current session's ordered visible `msg...`
IDs after existing partial-compaction sidecars are applied.
The optional TUI entrypoint also registers `/partial_compact` and
`/partial-compact`; the command opens a checkpoint picker and
submits a prompt that points at `partial_compact_instructions` rather than
embedding the full instruction block.

Older local checkouts exposed the same operation as `pc_compact`.
New prompts and automation should call `partial_compact`;
the old name is intentionally not registered as an alias so
the model sees one compaction mutator plus read-only helper tools.

## `partial_compact`

```jsonc
{
  "name": "partial_compact",
  "description": "from src/prompts/partial-compact-tool-description.md",
  "args": {
    "ranges": {
      "type": "array",
      "description": "from src/prompts/partial-compact-arg-ranges.md"
    }
  },
  "returns": {
    "n_ranges_compacted": "int",
    "ranges_compacted": "array (includes session_id, message endpoints, n_messages_replaced, truncated)",
    "n_messages_replaced": "int",
    "truncated": "bool (true if summary was longer than max_summary_chars)",
    "active_compactions": "int",
    "total_known_messages_replaced": "int (sum for records created by versions that stored this count)",
    "note": "string"
  }
}
```

The model-visible tool descriptions and
argument descriptions are Markdown source files under `src/prompts/`;
`bun run build` copies them to `dist/prompts/` for runtime loading.

Batch mode prevalidates all requested current-session ranges before the sidecar
is written.
Ranges must be disjoint within the current session and
must not overlap active compaction records.
Persistence is atomic for the current session sidecar.

After a successful write,
the tool records the current post-compaction visible token estimate as
the reminder baseline.
This prevents a just-compacted session from receiving another reminder on
the next turn unless enough new visible context has actually accumulated.

## `partial_compact_instructions`

Returns `<instruction name="opencode-partial-compact">...</instruction>`.
The instruction explains why to compact, what to preserve, how to
target staying below 50%, how to
retain important system/user prompt requirements while
compacting pasted logs/tool output, and when to
prefer one current-session `ranges` batch call.
It does not append message IDs;
use `partial_compact_current_session_message_ids` for endpoint selection.

## `partial_compact_current_session_message_ids`

Returns the current session's ordered visible `msg...`
IDs after existing partial-compaction sidecars are applied.
The list is a snapshot; agents should use the newest list and
refresh this tool after `partial_compact` or
later turns before choosing endpoints.

## Periodic reminder

The server hook adds one short system reminder after the estimated
model-visible context grows by `reminder_interval_tokens` since
the last reminder. Default: `16000`.
The reminder is not persisted as a session message;
only its last emitted estimate is stored in the sidecar so
it does not repeat every turn.

`reminder_interval_tokens` is a target cadence, not a promise to
wait past a small model's entire context window.
If the active model reports an input budget or context window smaller than
the configured target, the runtime clamps the effective interval to
an internal ~80% safety point.
If both limits are unknown, the configured target is used unchanged.

The reminder is a mandatory context-hygiene checkpoint, not a command to
compact every time it appears.
This plugin disables Opencode native auto-compaction in
the merged runtime config, so the agent is responsible for
keeping context healthy with `partial_compact` when
there is context pressure or stale raw evidence that is not very likely to
be useful soon.
The injected reminder text is intentionally just a compact status line, for
example:

```text
current context window: 42k (37% full)
```

It does not repeat the full guide and does not append message IDs.
Agents can call `partial_compact_instructions` for
the full named instruction block and
`partial_compact_current_session_message_ids` for current visible endpoints.
The TUI slash command selects one checkpoint range and sends an agent prompt.
It does not have a separate multi-range picker or automatic mode; if
the agent sees additional disjoint stale ranges, it batches them through
`partial_compact` with `ranges`.
Agents should target staying below 50% visible context rather than waiting for
overflow.
They must not compact merely because a reminder appeared, but
below 50% they should still compact after investigation, implementation,
verification, review, commit, or push when stale context has low future value.
Compact large diffs after commit,
repeated status/diff/test output after results are known,
resolved reviewer transcripts, failed probes after the conclusion is recorded,
obsolete file reads, and
background-agent progress logs after their final answer is captured.
At or above 50%,
compact stale context promptly until the visible view is back under 50%.
At 80% this is urgent before more long-running tools or broad exploration;
at 90%, compact anything not immediately needed while keeping goals, decisions,
file paths, errors, assumptions, outcomes, and message IDs that are likely to
be useful later.

Summaries should include compacted message IDs only when
those old IDs are likely to be useful for precise recovery.
It is acceptable for newer summaries to summarize older summaries and point to
durable files, decisions, results, or the newest useful summary trail instead.
If later context is needed around a message ID,
use the message search/read tools for the current session history;
the fixed tool names in this environment are `session_search` and
`session_read`.

After compaction shrinks the visible view,
the sidecar reminder baseline is reset to the post-compaction estimate so
cadence neither stalls behind the old high-water mark nor
fires again immediately on the next turn.

## Validation performed at call time

- Range non-empty and within the current session. Else error `"message msg...
    not found in this session"`.
- Range start must not come after range end in the current message order.
    Else error `"from_message_id msg...
    must not come after to_message_id msg..."`.
- Range does not overlap any active compaction.
    Else error `"range overlaps compaction starting at msg..."`.
- Batch ranges do not overlap each other within the current session.
    Else error `"range overlaps another requested range starting at msg..."`.
- Range does not include any synthetic compaction marker we previously
    emitted.
    Else error `"range includes a prior compaction;
    cannot compact a compacted region"`.
- Range does not split a tool-pair.
    If a boundary cuts between a tool call and its paired result,
    the tool returns a targeted error telling the agent whether to
    extend the upper bound, extend the start backward, or
    start after the result.

`auto_expand` is **not** offered in v0; the agent fixes the range itself.

## Deliberately not provided

- `pc_peek`.
    Tool results persist into `PartTable` and would defeat the compaction.
    If the agent needs originals back, it re-reads the source (file,
    command output, etc.).
- `pc_restore`.
    Cache miss without payoff;
    the agent can always emit a new turn re-stating the forgotten info.
- `pc_list`.
    Tag injection is not used in v0; if the agent needs to audit its context,
    it inspects what's in its window.

These can be added in v0.1 if real session traces show the gap.

## What the model sees after a compaction

The collapsed range becomes one synthetic text part attached to
the first message of the compacted range:

```text
[compacted: msg01HZQ..3 .. msg01HZQ..7 — Read 12 files
(src/main.rs, cargo.toml, ...) — none relevant to the parser bug.]
```

Tag format is byte-stable across calls (no timestamps, no per-call data).
This is the F4 invariant — enforced by
a snapshot test before any compaction logic lands.
