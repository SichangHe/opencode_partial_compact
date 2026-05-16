# Agent Tools (v0)

One tool. Prefixed `pc_` to avoid collisions with oh-my-openagent and
Opencode built-ins.

## `pc_compact`

```jsonc
{
  "name": "pc_compact",
  "description":
    "Replace a contiguous range of past messages in your context with a single summary you write. The originals stay in the session log but are removed from your working view. Use to drop content you no longer need to remember — e.g. file reads that turned out irrelevant, edit-then-fix loops, long CLI outputs whose conclusion is the only part that matters.\n\nPrefer compacting RECENT unneeded content over rewriting deep history. Compacting the middle of history invalidates prompt cache; tail-region compactions are near-free.\n\nThe summary will replace the entire range — write it like a note to your future self: state what happened, what's relevant, and reference file names / tool names you may want to recall.",
  "args": {
    "from_message_id": {
      "type": "string",
      "description": "Starting message ID (msg...). Inclusive."
    },
    "to_message_id": {
      "type": "string",
      "description": "Ending message ID (msg...). Inclusive. May equal from_message_id."
    },
    "summary": {
      "type": "string",
      "description": "Concise replacement text. Hard cap: max_summary_chars (default 2000). Truncation reported in tool result."
    }
  },
  "returns": {
    "n_messages_replaced": "int",
    "truncated": "bool (true if summary was longer than max_summary_chars)"
  }
}
```

## Validation performed at call time

- Range non-empty and within current session. Else error
  `"range outside this session"`.
- Range does not overlap any active compaction. Else error
  `"range overlaps compaction starting at msg..."`.
- Range does not include any synthetic compaction marker we previously
  emitted. Else error
  `"range includes a prior compaction; cannot compact a compacted region"`.
- Range does not split a tool-pair (a `tool_use` part in the last
  message paired with a `tool_result` part in the message immediately
  after `to_message_id`, or vice versa across `from_message_id - 1`).
  Else error
  `"range splits a tool_use/tool_result pair at msg... — adjust range
  to include the partner message"`.

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
