import type { Part } from "@opencode-ai/sdk/v2"
import type { TuiCommand, TuiDialogSelectOption, TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { loadStateFresh } from "./state.js"
import { validateRange } from "./validate.js"
import {
  buildPartialCompactCheckpoints,
  buildPartialCompactPrompt,
  firstCompactableMessageID,
  type PartialCompactCheckpoint,
  type TuiMessage,
} from "./tui-checkpoints.js"

function currentSessionID(api: TuiPluginApi): string | null {
  const current = api.route.current
  if (current.name !== "session") return null
  const sessionID = current.params?.sessionID
  return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : null
}

function showError(api: TuiPluginApi, message: string): void {
  api.ui.toast({ variant: "error", title: "partial compact", message })
}

function checkpointOptions(
  checkpoints: readonly PartialCompactCheckpoint[],
): TuiDialogSelectOption<PartialCompactCheckpoint>[] {
  return checkpoints.map(checkpoint => ({
    title: checkpoint.title,
    value: checkpoint,
    description: checkpoint.description,
  }))
}

async function startPartialCompact(api: TuiPluginApi): Promise<void> {
  const sessionID = currentSessionID(api)
  if (!sessionID) {
    showError(api, "Open a session before running /partial_compact.")
    return
  }

  const messages: readonly TuiMessage[] = api.state.session.messages(sessionID)
  if (messages.length === 0) {
    showError(api, "This session has no messages to compact.")
    return
  }

  let records
  try {
    records = (await loadStateFresh(sessionID)).compactions
  } catch (err) {
    showError(api, err instanceof Error ? err.message : String(err))
    return
  }
  const fromMessageID = firstCompactableMessageID(messages, records)
  if (!fromMessageID) {
    showError(api, "No uncompacted messages remain in this session.")
    return
  }

  const partsByMessage = new Map<string, readonly Part[]>()
  for (const msg of messages) {
    partsByMessage.set(msg.id, api.state.part(msg.id))
  }
  const validationMessages = messages.map(msg => ({
    info: { id: msg.id, sessionID },
    parts: [...(partsByMessage.get(msg.id) ?? [])],
  }))
  const checkpoints = buildPartialCompactCheckpoints(messages, partsByMessage, records)
    .filter(checkpoint => validateRange(fromMessageID, checkpoint.messageID, validationMessages, records) === null)
  if (checkpoints.length === 0) {
    showError(api, "No valid partial compaction checkpoints found.")
    return
  }

  api.ui.dialog.replace(() =>
    api.ui.DialogSelect<PartialCompactCheckpoint>({
      title: "Compact through checkpoint",
      placeholder: "Select where old context should be summarized through",
      options: checkpointOptions(checkpoints),
      onSelect: (option) => {
        const prompt = buildPartialCompactPrompt({
          fromMessageID,
          toMessageID: option.value.messageID,
          checkpointTitle: option.value.title,
        })
        api.ui.dialog.clear()
        void api.client.session.prompt({
          sessionID,
          parts: [{ type: "text", text: prompt }],
        })
      },
    }),
  )
}

const tui: TuiPlugin = async (api) => {
  const dispose = api.command?.register((): TuiCommand[] => [
    {
      title: "Partial compact",
      value: "partial_compact",
      category: "Session",
      description: "Summarize old context through a selected checkpoint.",
      slash: {
        name: "partial_compact",
        aliases: ["partial-compact"],
      },
      onSelect: () => {
        void startPartialCompact(api)
      },
    },
  ])
  if (dispose) api.lifecycle.onDispose(dispose)
}

export default {
  id: "opencode-partial-compact-tui",
  tui,
}
