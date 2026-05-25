Current-session message IDs for `partial_compact`:
- Use these stable current-session `msg...` IDs as `from_message_id` and `to_message_id` endpoints.
- This list is a snapshot from the current message history after partial-compaction sidecars are applied. Use the newest ID list; after later turns, refresh `partial_compact_instructions` before choosing endpoints. Do not call `partial_compact` again immediately unless a distinct safe stale range remains.

{{MESSAGE_ID_LINES}}
