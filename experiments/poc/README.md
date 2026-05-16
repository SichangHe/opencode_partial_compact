# opencode-partial-compact POC

## What this POC proves

This minimal Opencode plugin skeleton proves two assumptions needed before committing to a full partial-context-compaction plugin design.

**E1 — Tool registration:** The plugin exports a tool called `pc_demo` via the `tool` key of the `Hooks` object returned by `server()`. This confirms that the `@opencode-ai/plugin` `tool()` helper wires cleanly into the plugin contract and that a custom LLM-callable tool (one string argument, fixed string return) can be registered and executed through Opencode's normal tool dispatch.

**E2 — `experimental.chat.messages.transform` hook:** The plugin registers a handler on `experimental.chat.messages.transform`. Each time Opencode fires the hook before sending messages to the LLM, the handler logs `messages.length` to `/tmp/pc-poc.log` and mutates `output.messages` in place by appending a sentinel `TextPart` (text: `<pc-poc-was-here>`, `synthetic: true`) to the last message's `parts` array. This confirms that in-place mutation of the messages array works and is the correct mechanism for a compaction plugin to drop or replace message parts before they reach the LLM.

## How to install / load this plugin in Opencode

1. Build the plugin: `npm install && npm run build` inside this directory.
2. In your Opencode project's `opencode.json` (or `~/.config/opencode/opencode.json`), add the plugin path to the `plugin` array:

```json
{
  "plugin": ["/ssd1/sichangheagent/opencode_partial_compact/experiments/poc/dist/index.js"]
}
```

3. Start (or restart) Opencode in that project directory. Opencode discovers and loads plugins listed in the config at startup.

## Expected output

After loading the plugin and starting a chat session you should observe:

- In the Opencode tool list (visible in the UI or via `/tools`): a tool named `pc_demo` with description "POC demo tool."
- In `/tmp/pc-poc.log`: a line containing `Plugin server() called` when Opencode starts, followed by one `messages.transform fired — messages.length=N` line per LLM call.
- If you ask the LLM to call `pc_demo` with any string, a further line appears: `pc_demo executed with message="..."` and the LLM receives the echoed string.
- The sentinel part (`<pc-poc-was-here>`) is appended in-process; it will not be visible in the Opencode UI (it is marked `synthetic: true`) but will appear in the raw HTTP body sent to the provider if you capture it with a proxy.
