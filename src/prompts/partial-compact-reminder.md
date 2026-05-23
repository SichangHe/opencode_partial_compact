Partial compaction checkpoint ({{CONTEXT_STATUS}}): built-in auto-compaction is disabled, so consider `partial_compact` when the session has bulky stale context or context pressure. Do not compact just because this reminder appeared; compact only when the removed raw text has low future value.

{{REMINDER_EXCERPT}}

{{INSTRUCTION_POINTER}}

Before compacting, call `partial_compact_instructions` unless the full `{{INSTRUCTION_NAME}}` instruction block is already in context. If there is no safe stale range, continue the task without calling `partial_compact`.

If you later need details around a message ID, use session history tools when available: `session_search` can search for that ID within a session, and `session_read` can read broader session context.
