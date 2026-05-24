# Persistence (v0, locked: SIDECAR)

## Decision

**JSON sidecar.** Piggyback on Opencode's `CompactionPart` mechanism
was investigated and rejected — see [Spike outcome](#spike-outcome)
below. Sidecar matches DCP's proven pattern and has the cleaner
boundary.

## Storage path

```text
~/.local/share/opencode/storage/plugin/opencode-partial-compact/{sessionId}.json
```

One file per Opencode session. The plugin storage directory is the
convention Opencode already manages; DCP uses
`.../plugin/dcp/{sessionId}.json` with the same shape.

## Schema

```jsonc
{
  "schema_version": 1,
  "session_id": "ses01HZQ...",
  "compactions": [
    {
      "session_id": "ses01HZQ...",
      "from_message_id": "msg01HZQ..3",
      "to_message_id":   "msg01HZQ..7",
      "summary": "Read 12 files (...) — irrelevant.",
      "n_messages_replaced": 5,
      "created_at_iso": "2026-05-16T..."
    }
    // sorted ascending by from_message_id (= time order on monotonic IDs)
  ],
  "last_reminder": {
    "visible_token_estimate": 42000,
    "message_id": "msg01HZQ..9",
    "created_at_iso": "2026-05-16T..."
  },
  "last_written_iso": "2026-05-16T..."
}
```

Notes:
- No separate compaction ID. The `from_message_id` is the natural key
  (records can't overlap, so it's unique).
- `n_messages_replaced` and `last_reminder` are observability/cadence fields;
  older sidecars without them remain valid.
- `last_written_iso` is for human debugging only; not used in logic.

## I/O

| When | Action |
|---|---|
| Plugin `server()` init | Note storage dir; lazy per-session load. |
| First time we see a `sessionID` in the hook | Try to read sidecar; absent → empty in-memory state for this session. |
| `partial_compact` tool succeeds | Append record(s) to in-memory state; write once per target session (atomic per sidecar), then best-effort update `last_reminder` to the post-compaction visible estimate. |
| Subsequent hook fires | Read in-memory state (no disk hit); collapse view. |
| Reminder threshold reached | Store the last reminder message ID and visible-token estimate. |
| Native Opencode compaction starts | The plugin fails closed through `experimental.session.compacting`; reconciliation remains as damage control if a native compaction part is later visible. |
| Native Opencode compaction makes a record's endpoints unresolvable | Prune that stale record from sidecar and cache. |
| Session end | Nothing extra; last successful write is already on disk. |

### Atomic write

```text
write JSON to {sessionId}.json.tmp
fsync the tmp file
rename({sessionId}.json.tmp, {sessionId}.json)
```

On crash mid-write, the previous file is intact. Last successful
record persists.

### In-memory cache

Per-process `Map<SessionID, SessionState>`. Loaded once per session
(on first hook fire or first `partial_compact` for the session), written
through on every mutation. Hook does not re-read from disk per call —
that would add fs latency to every LLM round-trip.

## Failure handling

Detailed in [`70-failure-modes.md`](70-failure-modes.md) (F5, F6, F8,
F10):

- Parse failure → log loud warning, rename bad file to
  `{sessionId}.json.bad-{epoch}`, treat as empty.
- `schema_version > 1` → refuse to operate on that sidecar with a
  clear error.
- Record references a message ID Opencode's native compaction already
  discarded → skip during view rewrite and prune after seeing a native
  compaction part in the transformed view.
- Concurrent Opencode processes on same session → out of scope for v0;
  atomic rename mitigates worst case (last writer wins).

## Spike outcome (why not piggyback)

Timeboxed 1 hr spike investigated whether we could write a
`CompactionPart` row via the Opencode SDK and let Opencode's own
`filterCompactedEffect` honour it.

Result: piggyback is structurally possible but functionally useless
in v0.

- `filterCompactedEffect` at
  `packages/opencode/src/session/message-v2.ts:1023..1034` only
  truncates when there is a co-located `summary: true` assistant
  message. That flag is set internally by Opencode's session
  processor; plugins can't set it. Without it, our marker gets stored
  but doesn't trigger Opencode's truncation.
- Therefore we'd have to do **manual collapse in
  `experimental.chat.messages.transform` anyway** — same logic as the
  sidecar approach. Zero behavioural win from piggyback.
- The v2 SDK's `Part.update()` (which is what would let a plugin
  insert a Part) is not in `@opencode-ai/plugin`'s exposed `client`.
  Using it would require constructing our own v2 client with auth
  headers (via `Flag.OPENCODE_SERVER_PASSWORD`) — significant
  integration surface, all of it on Opencode's `experimental` HTTP
  API group.
- Several unverified risks (PartID generation conflicts, session-busy
  check during hook, `experimental` group enablement) would all need
  validation before shipping.

Net: sidecar gets us the same behaviour with a clean boundary, no
Opencode-internals dependency, and the same failure modes DCP runs in
production with. Revisit in v0.2 only if Opencode exposes a non-
`experimental` plugin API for arbitrary Parts AND a `filterCompacted`
contract that honours partial ranges.
