<instruction name="opencode-partial-compact">
Partial compaction replaces no-longer-needed messages from the agent's context window with agent-provided summaries.

Strongly consider partial compaction for stale bulky context: long tool output with short takeaways, resolved detours, repeated investigation, or anything irrelevant to the current task.

Each summary should say what was removed, why it is safe to forget verbatim, and the durable facts needed later. Cite the compacted message IDs.

MUST preserve instead of replace:
- active system, developer, tool, and user instructions;
- user prompts, except bulky pasted logs, traces, generated output, or other replaceable bulk;
- key decisions, assumptions, unresolved questions, blockers, and risks;
- information needed for the current task or immediately foreseeable follow-up work.

Use `partial_compact_instructions` to refresh the current visible message IDs before choosing endpoints. The message-ID list is included because compacted sessions can hide messages and the newest safe endpoints may differ from what you remember.
Call `partial_compact` with `ranges: [{ session_id?, from_message_id, to_message_id, summary }]`; omit `session_id` for the current session, and batch multiple disjoint stale ranges only when each summary is safe.

Tail compaction: regardless of current context size, summarize the newest unneeded stale messages to keep the working context lean and preserve KV cache.

Full-session compaction: above 50% context usage, compact stale bulky context more aggressively, starting with recent stale ranges and moving backward as needed. Above 90%, compact anything not immediately needed.

Original messages remain in the session log and can be found later with `session_search` or `session_read`.
</instruction>
