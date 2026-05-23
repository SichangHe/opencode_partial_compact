Manual partial compaction requested from the TUI.

{{INSTRUCTION_BLOCK}}

Range:
- from_message_id: {{FROM_MESSAGE_ID}}
- to_message_id: {{TO_MESSAGE_ID}}
- selected checkpoint: {{CHECKPOINT_TITLE}}

Write a concise replacement summary for exactly this contiguous range, then call partial_compact once with those exact message IDs and your summary. If you identify additional disjoint stale ranges while following the instruction, use one batch call with ranges instead of repeated partial_compact calls. Preserve only facts needed later: decisions, file paths, tool outputs, errors, assumptions, outcomes, and session IDs. Do not ask follow-up questions. After the tool succeeds, report the result briefly.
