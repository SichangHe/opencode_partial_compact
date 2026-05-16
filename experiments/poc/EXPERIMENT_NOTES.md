# Experiment Notes

## (a) TypeScript compile errors / warnings and how they were resolved

Running `bunx tsc --noEmit` produced **zero errors** on the final source. The only non-obvious decision was the `moduleResolution: "bundler"` setting in `tsconfig.json`. The DCP project uses the same setting and it is required because `@opencode-ai/plugin/package.json` uses `exports` maps (no bare `.js` extensions in the package's own source), which Node16/NodeNext resolution cannot handle without the `.js` suffix on every import. Using `"bundler"` resolution sidesteps this.

One earlier draft imported `TextPart` from `@opencode-ai/sdk` explicitly and annotated the sentinel with that type. That draft produced a type mismatch because `Part` is a discriminated union and TypeScript inferred the literal `"text"` in `type: "text" as const` correctly without the import. Removing the explicit import kept the file shorter and still type-checked cleanly.

## (b) Uncertainties about the plugin contract

1. **`experimental.chat.messages.transform` input shape.** The hook signature in `packages/plugin/src/index.ts` is `(input: {}, output: { messages: { info: Message; parts: Part[] }[] })`. The `input` object is typed as an empty object. It is unclear whether Opencode passes any additional properties at runtime (e.g., `sessionID`) that are simply not typed. DCP's implementation casts the first argument as `{}` and ignores it entirely, which was adopted here.

2. **Whether mutating `parts` in place is sufficient vs. replacing `output.messages`.** DCP mutates individual entries of `output.messages` (both the `parts` arrays and message content) without ever reassigning `output.messages` itself. This suggests Opencode passes the array by reference and reads it back after the hook returns. The POC follows the same pattern, but there is no authoritative comment in Opencode's source confirming that reassigning `output.messages = newArray` would also work.

3. **Sentinel part validity.** `TextPart` requires `id`, `sessionID`, and `messageID`. For the sentinel, `id` is hard-coded to `"pc-poc-sentinel"`. If Opencode deduplicates parts by `id` within a session, running the hook twice would silently drop the second sentinel. A production plugin should generate a unique id (e.g., `crypto.randomUUID()`).

4. **Plugin loading path.** The Opencode config key is assumed to be `plugin` (an array of strings or `[string, options]` tuples) based on the `Config` type in `packages/plugin/src/index.ts`. No integration test was run to confirm Opencode actually reads that key from `opencode.json` at startup — this remains a human-verification step.

5. **`PluginModule` vs bare `Plugin` export.** The plugin API supports two export shapes: a `PluginModule` object with a `server` property, and a bare `Plugin` function. DCP exports a bare `Plugin` (`export default server`). The `@opencode-ai/plugin` source shows `PluginModule = { id?: string; server: Plugin; tui?: never }`. The POC uses `PluginModule` (with `id`) to match the more structured form; it is unclear which form Opencode prefers when both are valid.

## (c) Manual steps required to load this plugin and observe its behavior

1. Build the plugin: run `npm install && npm run build` inside `experiments/poc/`. This produces `dist/index.js`.
2. Locate (or create) your Opencode config file — either `opencode.json` in the project root or `~/.config/opencode/opencode.json` globally.
3. Add the absolute path to `dist/index.js` to the `plugin` array in that config file.
4. Start Opencode (`opencode` CLI) in a directory covered by that config.
5. Verify the tool is registered by typing `/tools` or starting a chat and asking the model to list available tools. Look for `pc_demo`.
6. Trigger a chat message (any prompt) and then inspect `/tmp/pc-poc.log` to confirm the `messages.transform` line was written.
7. Ask the LLM to call `pc_demo` with an arbitrary string and confirm the `pc_demo executed` log line appears and the LLM receives the echoed return value.
8. To verify the sentinel mutation, run Opencode behind an HTTP proxy (e.g., `mitmproxy`) and inspect the raw request body sent to the LLM provider; the last message's `content` array should contain a text block with `<pc-poc-was-here>`.
