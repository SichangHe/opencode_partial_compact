Current-session message IDs for `partial_compact` (chronological):
- session_id: {{SESSION_ID}}
- Use these stable `msg...` IDs as `from_message_id` and `to_message_id` endpoints for current-session ranges.
- Omit `session_id` when compacting this current session.
- This list is a snapshot from session history after partial-compaction sidecars are applied. Use the newest ID list; after later turns, refresh `partial_compact_instructions` before choosing endpoints. Do not call `partial_compact` again immediately unless a distinct safe stale range remains.

{{MESSAGE_ID_LINES}}
