# Agent Tools (v0)

Two tools. `partial_compact` matches the user-facing slash command while
remaining clear of oh-my-openagent and Opencode built-ins.
`partial_compact_instructions` returns the named instruction block
`opencode-partial-compact`; agents should read it before calling
`partial_compact` if it is not already in the context window. The optional TUI
entrypoint also registers `/partial_compact` and `/partial-compact`; the command
opens a checkpoint picker and submits a prompt that includes the full
instruction block.

Older local checkouts exposed the same operation as `pc_compact`. New prompts
and automation should call `partial_compact`; the old name is intentionally not
registered as an alias so the model sees one compaction mutator plus one
read-only instruction tool.

## `partial_compact`

```jsonc
{
  "name": "partial_compact",
  "description":
    "Before calling `partial_compact`, read instruction `opencode-partial-compact` via `partial_compact_instructions` if that instruction block is not already in your context window. Replace one contiguous range, or multiple disjoint ranges with `ranges`, using summaries you write...",
  "args": {
    "from_message_id": {
      "type": "string",
      "description": "Starting message ID (msg...). Inclusive. Legacy single-range mode; do not mix with ranges."
    },
    "to_message_id": {
      "type": "string",
      "description": "Ending message ID (msg...). Inclusive. Legacy single-range mode; do not mix with ranges."
    },
    "summary": {
      "type": "string",
      "description": "Concise replacement text for legacy single-range mode."
    },
    "ranges": {
      "type": "array",
      "description": "Multiple disjoint ranges to compact in one call. Each item accepts optional session_id plus from_message_id, to_message_id, and summary. Do not mix with legacy fields."
    }
  },
  "returns": {
    "n_ranges_compacted": "int (batch mode only)",
    "ranges_compacted": "array (batch mode only; includes session_id, endpoints, n_messages_replaced, truncated)",
    "n_messages_replaced": "int",
    "truncated": "bool (true if summary was longer than max_summary_chars)",
    "active_compactions": "int",
    "total_known_messages_replaced": "int (sum for records created by versions that stored this count)",
    "note": "string"
  }
}
```

Batch mode prevalidates all requested ranges before any sidecar is written.
Ranges must be disjoint within each target session and must not overlap active
compaction records. Persistence is atomic per target session sidecar; when a
batch spans multiple sessions, an I/O failure can be reported after an earlier
target session was already written. Omitting `session_id` targets the current
session; including it targets another session whose message IDs the agent has
verified.

## `partial_compact_instructions`

Returns `<instruction name="opencode-partial-compact">...</instruction>`. The
instruction explains why to compact, what to preserve, how to choose tail vs.
aggressive pruning based on context-window percentage, how to retain important
system/user prompt requirements while compacting pasted logs/tool output, how
to mention compacted session IDs, and when to prefer one `ranges` batch call.

## Periodic reminder

The server hook adds one short system reminder after the estimated
model-visible context grows by `reminder_interval_tokens` since the last
reminder. Default: `16000`. The reminder is not persisted as a session message;
only its last emitted estimate is stored in the sidecar so it does not repeat
every turn.

`reminder_interval_tokens` is a target cadence, not a promise to wait past a
small model's entire context window. If the active model reports a context
window smaller than the configured target, the runtime clamps the effective
interval to an internal ~80% safety point. If the model limit is unknown, the
configured target is used unchanged.

The reminder is intentionally mandatory, not just a suggestion. This plugin
requires Opencode native auto-compaction to be disabled, so the agent is
responsible for keeping context healthy with `partial_compact`. The reminder
shows the estimated visible token count and, when the model context limit is
available, the percentage of the context window in use. It includes a short
phase-boundary excerpt and points to `partial_compact_instructions` for the full
named instruction block. The full guide is not repeated every cadence tick;
the TUI slash command and `partial_compact_instructions` return the full block.

Agents must not treat a low percentage as "do nothing" when a phase has ended.
Below 50%, compaction is still useful after investigation, implementation,
verification, review, commit, or push if raw evidence has low future value.
Compact large diffs after commit, repeated status/diff/test output after
results are known, resolved reviewer transcripts, failed probes after the
conclusion is recorded, obsolete file reads, and background-agent progress logs
after their final answer is captured. As the window gets closer to full, compact
stale old context more aggressively: remove obsolete raw details like full
compaction would, while keeping goals, decisions, file paths, errors,
assumptions, outcomes, and session IDs needed later.

Summaries should mention the current session ID naturally when known and include
any other referenced session IDs. If later context is needed around a message
ID, use session-history tools when available: `session_search` can search for a
message ID inside a session and `session_read` can recover broader context from
that session.

After compaction shrinks the visible view, the sidecar reminder baseline is
reset so cadence does not stall until context exceeds the old high-water mark.

## Validation performed at call time

- Range non-empty and within target session. Else error
  `"message msg... not found in this session"`.
- Range start must not come after range end in the current message order. Else
  error `"from_message_id msg... must not come after to_message_id msg..."`.
- Range does not overlap any active compaction. Else error
  `"range overlaps compaction starting at msg..."`.
- Batch ranges do not overlap each other within the same target session. Else
  error `"range overlaps another requested range starting at msg..."`.
- Range does not include any synthetic compaction marker we previously
  emitted. Else error
  `"range includes a prior compaction; cannot compact a compacted region"`.
- Range does not split a tool-pair. If a boundary cuts between a tool call and
  its paired result, the tool returns a targeted error telling the agent whether
  to extend the upper bound, extend the start backward, or start after the
  result.

`auto_expand` is **not** offered in v0; the agent fixes the range
itself.

## Deliberately not provided

- `pc_peek`. Tool results persist into `PartTable` and would defeat
  the compaction. If the agent needs originals back, it re-reads the
  source (file, command output, etc.).
- `pc_restore`. Cache miss without payoff; the agent can always emit
  a new turn re-stating the forgotten info.
- `pc_list`. Tag injection is not used in v0; if the agent needs to
  audit its context, it inspects what's in its window.

These can be added in v0.1 if real session traces show the gap.

## What the model sees after a compaction

The collapsed range becomes one synthetic text part attached to the
first message of the compacted range:

```text
[compacted: msg01HZQ..3 .. msg01HZQ..7 — Read 12 files
(src/main.rs, cargo.toml, ...) — none relevant to the parser bug.]
```

Tag format is byte-stable across calls (no timestamps, no
per-call data). This is the F4 invariant — enforced by a snapshot
test before any compaction logic lands.
