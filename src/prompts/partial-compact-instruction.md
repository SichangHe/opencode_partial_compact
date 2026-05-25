<instruction name="opencode-partial-compact">
Partial compaction replaces no-longer-needed messages from the agent's context window with agent-provided summaries.

Strongly consider partial compaction for any stale context that is not very likely to be useful soon: long tool output with short takeaways, resolved detours, repeated investigation, obsolete edits, or anything irrelevant to the current task.

Each summary should say what was removed, why it is safe to forget verbatim, and the durable facts needed later. Include old message IDs only when they are likely to be useful for precise recovery; otherwise prefer durable files, decisions, results, and the newest useful summary trail.

MUST preserve instead of replace:
- active system, developer, tool, and user instructions;
- user prompts, except bulky pasted logs, traces, generated output, or other replaceable bulk;
- key decisions, assumptions, unresolved questions, blockers, and risks;
- information needed for the current task or immediately foreseeable follow-up work.

Use `partial_compact_instructions` to refresh the current visible message IDs before choosing endpoints. The message-ID list is for precise current-session range selection and recovery when needed; compacted message ranges can hide messages and the newest safe endpoints may differ from what you remember.
Call `partial_compact` with `ranges: [{ from_message_id, to_message_id, summary }]`. Each object compacts only the selected current-session message range. Batch multiple disjoint stale message ranges only when each summary is safe.

Tail compaction: regardless of current context size, summarize the newest unneeded stale messages to keep the working context lean and preserve KV cache.

Context budget target: keep the visible context under 50% of the effective context/input budget whenever possible. Compact stale context even below that target when it is no longer very likely to be useful soon. If usage reaches or exceeds 50%, compact stale context now until the visible context is back under 50%, starting with recent stale ranges and moving backward as needed. Above 80%, treat compaction as urgent before more long-running tools or broad exploration. Above 90%, compact anything not immediately needed.

Original messages remain in the session log. If you need them later, use message search/read tools for the current session history; in the current toolset these fixed tool names are `session_search` and `session_read`.
</instruction>
