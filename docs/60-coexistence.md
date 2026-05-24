# Coexistence (v0)

## With `@tarquinen/opencode-dcp` — **REFUSE TO LOAD**

DCP rewrites the message array in the same hook and injects its own
`<dcp-message-id>` tags with disjoint semantics from ours. Running both
would produce two ID systems the agent could confuse.

On first chat hook use we read the resolved plugin list through the Opencode
client. The check is not run inside `server()` because the Opencode HTTP server
is not ready during plugin bootstrap. If `@tarquinen/opencode-dcp` is present,
we throw with:

```text
opencode-partial-compact: refusing to operate — @tarquinen/opencode-dcp is
also configured. They overlap and conflict. Pick one and remove the
other from opencode.json. See https://...
```

We do not try to integrate. v0.2 may; for v0, mutual exclusion is the
honest interface.

## With `oh-my-openagent` — REQUIRE BEFORE-US ORDER

Both consume `experimental.chat.messages.transform`. Our hook MUST run
**before** oh-my-openagent's so that:

- oh-my-openagent's `toolPairValidator` repairs any orphan we missed.
- oh-my-openagent's synthetic-turn injectors
  (`contextInjectorMessagesTransform`, `teamModeStatusInjector`,
  `teamMailboxInjector`, `ensureUserTurnAfterAssistantTail`) run AFTER
  ours, so we never compact content they just added.

On first chat hook use we compare our index vs. oh-my-openagent's index in the
resolved plugin list. If ours is later, **error and refuse to operate** (not
just warn — warnings get filtered in startup spam):

```text
opencode-partial-compact: refusing to operate — list this plugin BEFORE
oh-my-openagent in opencode.json. Current order: [oh-my-openagent,
opencode-partial-compact]. Required: [opencode-partial-compact,
oh-my-openagent].
```

If oh-my-openagent isn't present, no check.

## Tool name collisions

Avoided. Our tools are `partial_compact` and `partial_compact_instructions`.
Reserved by oh-my-openagent
(per discovery report): `grep`, `glob`, `skill`, `task`, `edit`,
`look_at`, `lsp_*`, `ast_grep_*`, `session_*`, `background_*`,
`team_*`, `task_*`, `interactive_bash`, `skill_mcp`, `call_omo_agent`.
Reserved by Opencode built-ins: read, edit, write, bash, etc. No
collision with `partial_compact`.

## Reserved identifiers

- Plugin id we use: `opencode-partial-compact`.
- Config filename we use: `opencode-partial-compact.json[c]`.
- Storage subdir (sidecar fallback):
  `~/.local/share/opencode/storage/plugin/opencode-partial-compact/`.

## Marker for other plugins to recognise

Our synthetic compaction parts carry:

```ts
{
  type: "text",
  text: "[compacted: session ses...: msg... .. msg... — <summary>]",
  synthetic: true,
  source: "opencode-partial-compact",
}
```

Other well-behaved plugins should not re-compact or re-process parts
with `source` set by a different plugin. We follow this rule for our
own marker: range validation rejects any range containing a prior
`source: "opencode-partial-compact"` part.

## With Opencode's own `/compact`

Native `/compact` is blocked while this plugin is enabled. Automatic native
compaction is disabled with `compaction.auto=false` by the plugin config hook,
and `experimental.session.compacting` fails closed if Opencode reaches the
native compaction path anyway. The `experimental.compaction.autocontinue` hook
also disables synthetic continuation after any native compaction that escaped the
primary guard. If a native compaction part is later present, our transform hook
still skips affected sidecar records and prunes a sidecar record only after the
full session message list confirms both endpoints are absent.
Future v0.1 may expose a slash-command status to inform the user.

## With sub-agents (oh-my-openagent's `call_omo_agent`)

Sub-agents run in their own session with their own SQLite rows. Our
state is per-session. No interaction. The parent agent's compactions
do not appear in sub-agent context and vice versa. Documented; no
code needed.
