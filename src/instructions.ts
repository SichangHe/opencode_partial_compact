export const PARTIAL_COMPACT_INSTRUCTION_NAME = "opencode-partial-compact"

export function partialCompactInstructionBlock(): string {
  return `<instruction name="${PARTIAL_COMPACT_INSTRUCTION_NAME}">
Use this instruction before calling \`partial_compact\`. If this block is not already in your current context window, call \`partial_compact_instructions\` and read it first.

Purpose:
- Partial compaction removes no-longer-needed raw context from the model-visible view while leaving the original Opencode session log intact.
- Explain why you are compacting in each summary: what became stale, what can be safely replaced, and what facts must remain available.
- Mention the current session ID naturally when known and include any other compacted or referenced session IDs in the summary.

What to preserve:
- Preserve active system/developer instructions, durable user requirements, current goals, decisions, file paths, errors, assumptions, outcomes, and session IDs.
- User prompts are usually important and not very long; retain their requirements. If a human pasted long logs, traces, generated output, or other bulky context inside a user message, preserve the user request and compact only the bulky attached material.
- Never compact information needed for the immediate task or foreseeable follow-up work.

How much to compact:
- Below roughly 50% of the context window: do not treat the low percentage as permission to ignore stale bulk. Compact after completed phases when raw text has low future value: large diffs after commit, repeated status/diff/test output after results are known, resolved reviewer transcripts, failed probes after the conclusion is recorded, and long background-agent progress logs after their final answer is captured.
- Do not compact stable decisions, open errors, or ranges you may need verbatim on the next turn; when unsure, wait until the next phase completes.
- Around 50-75%: prefer tail pruning. Compact recent bulky tool outputs, resolved detours, failed edit/debug loops, obsolete file reads, and one-off investigation logs that are no longer needed verbatim.
- Around 75-90%: compact more assertively. Keep concise summaries of decisions, file paths, errors, assumptions, and outcomes; remove raw details that can be re-read from files, tests, logs, or session history when available.
- Above roughly 90%: use aggressive pruning. Remove everything not needed for immediate and foreseeable future work, similar to full compaction, but keep a selective summary that preserves commitments, constraints, and recovery breadcrumbs.

Phase-boundary rule:
- After investigation, implementation, verification, review, commit, or push completes, actively look for bulky raw evidence whose conclusions are now durable in files, commits, todos, test results, or a concise summary.
- If compacting, say why the raw text is now stale. If skipping, no special explanation is required unless asked.
- Summaries should keep retrieval breadcrumbs: session ID if known, file paths, command names, command results, errors, commit hashes, unresolved questions, and the conclusion.

Pruning modes:
- Tail pruning: compact the newest stale context first, especially large tool outputs or exploratory detours that do not need to remain verbatim.
- Aggressive pruning: compact multiple old and recent stale ranges, leaving only what is needed to continue correctly.

How to call \`partial_compact\`:
- For one contiguous stale range, use the legacy fields: \`from_message_id\`, \`to_message_id\`, and \`summary\`.
- For multiple disjoint stale ranges, prefer one batch call with \`ranges: [{ session_id?, from_message_id, to_message_id, summary }, ...]\`. Omit \`session_id\` for the current session; include it when compacting another session whose message IDs you have verified. This applies all selected ranges in one tool call and saves turns/KV cache compared with repeated single-range calls.
- Each range summary should stand alone because each range becomes its own synthetic summary marker.
- Do not mix legacy single-range fields with \`ranges\` in the same call.
- If you later need details around a message ID, use session-history tools when available: \`session_search\` can search for that ID within a session, and \`session_read\` can read broader session context.
</instruction>`
}

export function partialCompactReminderExcerpt(): string {
  return [
    "Phase-boundary check, even below ~50% context: after investigation, implementation, verification, review, commit, or push completes, scan for bulky raw evidence whose conclusions are now durable in files, commits, tests, todos, or a short summary.",
    "Compact when safe: large diffs after commit; repeated status/diff/test output after results are known; resolved reviewer transcripts; failed probes after the conclusion is recorded; obsolete file reads; long background-agent progress after the final answer is captured.",
    "Do not compact active edits, open errors, unresolved questions, in-flight tool pairs, or anything needed for the immediate next step.",
    "Prefer one batch `partial_compact` with `ranges` over many tiny compactions. Summaries must keep breadcrumbs: session ID, file paths, command names/results, errors, commit hashes, unresolved questions, and the conclusion.",
  ].join(" ")
}

export function partialCompactInstructionPointer(): string {
  return `Before calling \`partial_compact\`, read instruction \`${PARTIAL_COMPACT_INSTRUCTION_NAME}\` via \`partial_compact_instructions\` if that instruction block is not already in your context window.`
}
