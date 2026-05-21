# Agent Tools (v0)

One tool. Named `partial_compact` to match the user-facing slash command while
remaining clear of oh-my-openagent and Opencode built-ins. The optional TUI entrypoint also registers
`/partial_compact` and `/partial-compact`; the command opens a checkpoint picker
and submits an instruction for the agent to call this tool from the first
eligible uncompacted message through the selected checkpoint.

Older local checkouts exposed the same operation as `pc_compact`. New prompts
and automation should call `partial_compact`; the old name is intentionally not
registered as an alias so the model sees a single unambiguous compaction tool.

## `partial_compact`

```jsonc
{
  "name": "partial_compact",
  "description":
    "Replace a contiguous range of past messages in your context with a single summary you write. Ask yourself: do you need to remember everything currently in your context window? If not, use this tool to replace no-longer-needed parts — bulky tool output, resolved detours, failed edit/debug loops, obsolete file reads, or one-off investigation logs — with a clear and succinct summary. The originals stay in the session log but are removed from your working view.\n\nPrefer compacting RECENT unneeded content over rewriting deep history. Compacting the middle of history invalidates prompt cache; tail-region compactions are near-free. After a phase stabilizes, proactively compact raw logs/details and keep only decisions, file paths, errors, assumptions, and outcomes needed later.\n\nThe summary will replace the entire range — write it like a note to your future self: state what happened, what's relevant, and reference file names / tool names you may want to recall.",
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
    "truncated": "bool (true if summary was longer than max_summary_chars)",
    "active_compactions": "int",
    "total_known_messages_replaced": "int (sum for records created by versions that stored this count)",
    "note": "string"
  }
}
```

## Periodic reminder

The server hook adds one short system reminder after the estimated
model-visible context grows by roughly `reminder_context_fraction` of the model
context window since the last reminder. Default: `0.1`, with a
`reminder_min_tokens` floor of `4000`. The reminder is not persisted as a
session message; only its last emitted estimate is stored in the sidecar so it
does not repeat every turn.

## Validation performed at call time

- Range non-empty and within current session. Else error
  `"message msg... not found in this session"`.
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
