# Prompt file inventory

This directory is the source of truth for Markdown prompt fragments used by the plugin. `bun run build` copies `src/prompts` to `dist/prompts`, so runtime packages load the built mirror while source edits should happen here.

## Files

- `current-session-message-ids.md`
  - Used by: `currentSessionMessageIDReference` in `src/message-ids.ts`.
  - Shown/injected when: returned by `partial_compact_current_session_message_ids`.
  - Purpose: lists the visible current-session `msg...` IDs that agents can use as `from_message_id` and `to_message_id` endpoints.


- `current-session-message-ids-tool-description.md`
  - Used by: `buildCurrentSessionMessageIDsTool` and `buildCurrentSessionMessageIDsToolWithClient` in `src/tool.ts`.
  - Shown/injected when: exposed as the tool description for `partial_compact_current_session_message_ids`.
  - Purpose: describes the helper tool that returns the refreshed visible current-session message-ID list without duplicating the full instruction block.

- `partial-compact-arg-ranges.md`
  - Used by: `buildCompactTool` in `src/tool.ts`.
  - Shown/injected when: exposed as the schema description for the `partial_compact` tool's top-level `ranges` argument.
  - Purpose: explains that `ranges` is an array of current-session ranges and names the required fields for each item.

- `partial-compact-instruction.md`
  - Used by: `partialCompactInstructionBlock` in `src/instructions.ts`.
  - Shown/injected when: returned by `partial_compact_instructions`.
  - Purpose: gives the full operating policy for partial compaction: what to compact, what to preserve, endpoint selection, batching, budget targets, and recovery guidance.

- `partial-compact-instruction-pointer.md`
  - Used by: `partialCompactInstructionPointer` in `src/instructions.ts`; rendered into tool descriptions in `src/tool.ts`.
  - Shown/injected when: included in the `partial_compact` tool description so the agent sees the instruction-tool prerequisite before using the compaction tool.
  - Purpose: short pointer telling the agent to refresh the full partial-compaction instructions before calling `partial_compact` unless those instructions are already in context.

- `partial-compact-instruction-tool-description.md`
  - Used by: `buildInstructionTool` and `buildInstructionToolWithClient` in `src/tool.ts`.
  - Shown/injected when: exposed as the tool description for `partial_compact_instructions`.
  - Purpose: describes the helper tool that returns only the full instruction block; use `partial_compact_current_session_message_ids` separately for refreshed IDs.

- `partial-compact-range-from-message-id.md`
  - Used by: `buildCompactTool` in `src/tool.ts`.
  - Shown/injected when: exposed as the field-level schema description for each range object's `from_message_id`.
  - Purpose: defines the inclusive starting message ID for a compacted range.

- `partial-compact-range-summary.md`
  - Used by: `buildCompactTool` in `src/tool.ts`.
  - Shown/injected when: exposed as the field-level schema description for each range object's `summary`.
  - Purpose: tells the agent what durable facts the replacement summary must preserve and when old message IDs are worth including.

- `partial-compact-range-to-message-id.md`
  - Used by: `buildCompactTool` in `src/tool.ts`.
  - Shown/injected when: exposed as the field-level schema description for each range object's `to_message_id`.
  - Purpose: defines the inclusive ending message ID for a compacted range and notes that it may equal the start ID.

- `partial-compact-reminder.md`
  - Used by: `reminderText` and `reminderTextWithMessageIDs` in `src/reminder.ts`.
  - Shown/injected when: injected into the model context by `maybeInjectReminder` when the configured reminder interval or usage-level threshold is crossed; no instruction text or message-ID list is appended.
  - Purpose: produces the compact context-window status reminder, e.g. `current context window: 42k (37% full)`.

- `partial-compact-tool-description.md`
  - Used by: `buildCompactTool` in `src/tool.ts`.
  - Shown/injected when: exposed as the main `partial_compact` tool description.
  - Purpose: explains when and how to call `partial_compact`, including current-session range selection, batching, and future-turn visibility behavior.

- `tui-partial-compact.md`
  - Used by: `buildPartialCompactPrompt` in `src/tui-checkpoints.ts`.
  - Shown/injected when: used as the prompt text for the TUI slash-command flow after the user selects one compaction checkpoint.
  - Purpose: points the agent to `partial_compact_instructions`, gives the exact selected range, and asks it to summarize that range before calling `partial_compact` with the selected IDs.
