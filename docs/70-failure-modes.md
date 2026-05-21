# Failure Modes (v0)

Only the v0-relevant ones. Older F-codes dropped along with the
features that produced them (`pc_peek`, `pc_restore`, `pc_list`,
dual-ID support). See [`02-critique-findings.md`](02-critique-findings.md).

## F1. Tool-pair split (v0: reject)

Compaction range puts a `tool_use` part in the last included message
without its `tool_result` (in the immediately following message), or
vice versa across the start boundary.

**v0 handling.** `partial_compact` validates and returns an error:
`"range splits a tool_use/tool_result pair at msg... — extend the range
to msg... or trim to msg..."`. The agent retries with corrected
bounds. Auto-expansion is rejected because it can silently swallow
assistant reasoning (Opus critique C7).

**Safety net.** oh-my-openagent's `toolPairValidator` runs after us
and repairs orphans if our validation ever misses one (e.g., bug).

## F2. Overlapping compactions

Agent calls `partial_compact` over a range that overlaps an active record.

**v0 handling.** Reject with `"range overlaps existing compaction
starting at msg..."`. No restore in v0 — agent works around with a
non-overlapping range.

## F3. Compaction of a previously-emitted synthetic compaction part

Agent's range includes a part with `source ==
"opencode-partial-compact"`.

**v0 handling.** Reject with `"range includes a prior compaction;
cannot compact a compacted region"`. Future v0.1 may allow "extend"
semantics; v0 just refuses.

## F4. Hook output not byte-stable across calls

If `messages.transform` produces different bytes for the same (log,
state), Anthropic prompt cache breaks silently. High-impact, silent.

**v0 handling.** `test/snapshot.test.ts` runs the hook twice on a
fixed fixture and `Buffer.equals`-compares outputs. CI-style script
that any contributor runs locally; we add it to `bun test` so it's
the default. Hard precondition for any logic change to `hook.ts`.

## F5. Sidecar corruption / version skew

**v0 handling.** Parse failure → log loud warning,
rename bad file to `{sessionId}.json.bad-{epoch}`, treat in-memory
state as empty for that session. Version skew → refuse to operate on
that sidecar with a clear error.

## F6. Reference to message ID not in this session

Agent passes a foreign or already-deleted ID.

**v0 handling.** Validate-time SQLite lookup via the plugin SDK
client. Not found → tool error `"message msg... not found in this
session"`. No state change.

## F7. Compaction empties visible context

Agent compacts everything except the current turn.

**v0 handling.** Allowed. The remaining synthetic marker is still
valid context.

## F8. Reference to a message ID Opencode's native compaction already discarded

Sidecar still has the record; the message no longer resolves in the
loaded array.

**v0 handling.** Hook skips the record during view rewrite. If a native
`compaction` part is present, the plugin fetches the full session
message list and prunes the sidecar record only when both range
endpoints are absent from that full list. If the full-session check
fails, pruning is skipped and chat continues.

This avoids deleting valid records when the transform input is only a
partial view.

## F9. Plugin ordering wrong (oh-my-openagent before us)

**v0 handling.** Refuse to operate on first chat/native-compaction hook use with a clear error
naming the required order. See `60-coexistence.md`.

## F10. DCP also configured

**v0 handling.** Refuse to operate on first chat/native-compaction hook use. See
`60-coexistence.md`.

## F11. SDK version skew

POC ran against Opencode 1.14.46. The packaged plugin targets
`@opencode-ai/plugin` and `@opencode-ai/sdk` `>=1.15.0`, which provide the TUI
plugin types and `experimental.session.compacting` hook used by this checkout.

**v0 handling.** Pin `peerDependencies: ">=1.15.0"`. Track Opencode releases
manually until a CI hookup. Document the empirically-validated Opencode version
in README.

## F12. Summary too long

Agent emits a 50K-token summary that defeats the purpose.

**v0 handling.** Hard cap from config (`max_summary_chars`, default
2000). Truncate with `[...truncated...]` and report `truncated: true`
in the tool result.

## Things explicitly out of scope for v0

- Multi-host shared storage.
- Encryption at rest.
- Cross-session compactions.
- Concurrent Opencode processes on the same session (single-process
  assumed; sidecar atomic rename is best-effort if used).
- Reward-hacking eval (OQ-11). Future evaluation work.
- Surface for "you have unresolvable records" status (OQ-12). v0.1.
- Sub-agent integration (OQ-13). Sessions are isolated; no plumbing
  needed.
- Interrupted-turn consistency (OQ-14). Single-process, atomic state
  writes after tool returns; the failure window is small. v0.1 may
  add transactionality.
- Agent copying msg-IDs into file edits (OQ-15). v0 doesn't inject
  IDs into the model view at all (no `<part id>` tags), so the model
  only sees IDs in tool descriptions/results — surface area is small.
- `PartID`/`MessageID` format upgrades (OQ-16). When Opencode
  changes ID format we cut a major version.
