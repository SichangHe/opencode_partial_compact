# Log / View Model (v0)

## Three layers

| Layer                | Storage                                                     | Mutated by                                     | Lifetime         |
| -------------------- | ----------------------------------------------------------- | ---------------------------------------------- | ---------------- |
| **Log** (immutable)  | Opencode SQLite `MessageTable` + `PartTable`                | Opencode core only                             | session lifetime |
| **View** (per-call)  | `WithParts[]` in memory                                     | `experimental.chat.messages.transform` plugins | one LLM call     |
| **Compaction state** | JSON sidecar (see [`50-persistence.md`](50-persistence.md)) | this plugin's `partial_compact`                | session lifetime |

We never modify the log.
Our hook rewrites the view per call using the compaction state.

## IDs (existing, reused)

- `MessageID`: `msg<26-char base62>`.
    Monotonic timestamp+counter from Opencode's `id/id.ts`.
    Totally ordered, stable across restarts.
- `PartID`: `prt<26-char base62>`. Same family.
    Not used by v0 tools (we operate at message granularity).

## Compaction record

```jsonc
{
  "key": "msg01HZQ..3",                  // first message ID of the range; doubles as the record's identity
  "from_message_id": "msg01HZQ..3",
  "to_message_id":   "msg01HZQ..7",
  "summary": "Read 12 files (...) — irrelevant.",
  "created_at_iso": "2026-05-16T..."
}
```

Sorted by `from_message_id` ascending (lex order = time order on
monotonic IDs). No separate `pc_id` namespace.

## View rewrite

```text
for each compaction C in state, sorted by C.from_message_id ascending:
  find messages M_i in the view whose id ∈ [C.from, C.to]
  drop all parts in those messages
  attach to the first M_i a single synthetic text part:
    {
      type: "text",
      text: "[compacted: <from>..<to> — <summary>]",
      synthetic: true,
      source: "opencode-partial-compact"
    }
  drop the remaining M_i messages from the array
```

The synthetic part carries `source: "opencode-partial-compact"` so
later hooks (and a future us) recognise it as ours and
skip it during their own processing.
See [`60-coexistence.md`](60-coexistence.md) for
how other plugins should treat it.

## Invariants the hook must preserve

- **Byte stability.** Same (log, state) → same output bytes. No
    timestamps, no per-call IDs in the synthetic text. (F4 — failure
    mode listed in [`70-failure-modes.md`](70-failure-modes.md);
    enforced by snapshot test.)
- **No double-compaction.** Synthetic parts we emit are never
    collapsed by another compaction; validation rejects ranges that
    include them.
- **Tool pair integrity.** The view emitted to the LLM has every
    `tool_use` paired with its `tool_result`. Range validation rejects
    splits (the agent fixes the range itself).

## Edge cases

- **Cross-message range.** Range spans multiple messages. All parts
    in interior messages are removed. The synthetic part attaches to
    whichever message survives (the first one in the range).
- **Compaction whose IDs no longer resolve.** Opencode's own
    `/compact` may have run and discarded the messages our record
    references. Hook skips such records in the transformed view. If a
    native `compaction` part is present, a full-session lookup confirms
    whether both endpoints are gone before the sidecar record is pruned.
- **Empty visible context after compaction.** Allowed. The synthetic
    marker is still valid context.
