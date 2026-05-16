# Coexistence (v0)

## With `@tarquinen/opencode-dcp` — **REFUSE TO LOAD**

DCP rewrites the message array in the same hook and injects its own
`<dcp-message-id>` tags with disjoint semantics from ours. Running both
would produce two ID systems the agent could confuse.

At `server()` invocation we read `ctx.config.plugin` (or whatever the
plugin SDK exposes as the resolved plugin list). If
`@tarquinen/opencode-dcp` is present, we throw with:

```text
opencode-partial-compact: refusing to load — @tarquinen/opencode-dcp is
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

At `server()` invocation we compare our index vs. oh-my-openagent's
index in the resolved plugin list. If ours is later, **error and
refuse to load** (not just warn — warnings get filtered in startup
spam):

```text
opencode-partial-compact: refusing to load — list this plugin BEFORE
oh-my-openagent in opencode.json. Current order: [oh-my-openagent,
opencode-partial-compact]. Required: [opencode-partial-compact,
oh-my-openagent].
```

If oh-my-openagent isn't present, no check.

## Tool name collisions

Avoided. Our only tool: `pc_compact`. Reserved by oh-my-openagent
(per discovery report): `grep`, `glob`, `skill`, `task`, `edit`,
`look_at`, `lsp_*`, `ast_grep_*`, `session_*`, `background_*`,
`team_*`, `task_*`, `interactive_bash`, `skill_mcp`, `call_omo_agent`.
Reserved by Opencode built-ins: read, edit, write, bash, etc. No
collision with `pc_compact`.

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
  text: "[compacted: msg... .. msg... — <summary>]",
  synthetic: true,
  source: "opencode-partial-compact",
}
```

Other well-behaved plugins should not re-compact or re-process parts
with `source` set by a different plugin. We follow this rule
ourselves: range validation rejects any range containing a
foreign-`source` synthetic part.

## With Opencode's own `/compact`

These coexist fine. If `/compact` runs and discards messages our
records reference, our hook silently skips those records (the
`from_message_id` no longer resolves in the loaded message array). No
user-visible breakage; debug log records the skip. Future v0.1 may
expose a slash-command status to inform the user.

## With sub-agents (oh-my-openagent's `call_omo_agent`)

Sub-agents run in their own session with their own SQLite rows. Our
state is per-session. No interaction. The parent agent's compactions
do not appear in sub-agent context and vice versa. Documented; no
code needed.
