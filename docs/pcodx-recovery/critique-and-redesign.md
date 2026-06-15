# critique and redesign

core critique

- current PCODX MCP path creates sidecar compaction only
  - fact
    - MCP server writes `ledger.json`
    - MCP server writes `rendered-visible-context.txt`
    - MCP receipts say `native_context_rewritten: false`
  - consequence
    - Codex's hidden native transcript still contains prior raw turns
    - the next normal Codex CLI model call still carries that transcript
    - reduced ledger render size is not evidence of Codex prompt shrink
- startup instructions cannot make this true
  - fact
    - `pcodx_startup_instructions` tells the worker to record and compact
    - it also admits the caveat that MCP tools do not rewrite the hidden transcript
  - consequence
    - agent compliance improves the artifact
    - it does not change the prompt items Codex already accumulated
- `codex debug prompt-input` is insufficient proof
  - useful for checking startup prompt content
  - not sufficient for proving live transcript deletion
  - does not by itself report completed-turn token shrink

why OpenCode differs

- OpenCode exposes a message transform hook before model dispatch
  - the plugin mutates the in-memory model-visible array
  - therefore the OpenCode-native request can shrink
- stock Codex MCP tools do not receive an equivalent mutation handle
  - no live thread id
  - no native transcript replacement API
  - no access to pending hidden context state
  - no ability to delete arbitrary middle history

redesign target

- implement PCODX as a Codex app-server controller
  - controller must own all future turns
  - controller must own the durable ledger
  - controller must render compacted visible context
  - controller must seed future Codex turns from that render
- make MCP sidecar optional or internal-only
  - use it as a memory ledger if helpful
  - never present it as native compaction
- route manager workers through the controller launcher
  - launch with `manager-agent-launch.ts`
  - continue with the emitted controller command
  - require worker reports to include controller run dir and session id

observable success criterion

- primary metric
  - app-server `thread/tokenUsage/updated`
  - compare `last.inputTokens` before and after compaction
- required evidence
  - raw sentinel text is present before compaction
  - raw sentinel text is absent from the next injected model-visible render
  - summary text is present after compaction
  - compacted turn's `last.inputTokens` shrinks materially
- minimum acceptance shape
  - one baseline app-server turn from bulky raw context
  - one compaction action
  - one follow-up app-server turn from compacted render
  - machine-readable report with raw tokens, compacted tokens, shrink tokens, shrink fraction, paths

redesign phases

- phase one
  - make controller launch the default PCODX worker path
  - keep stock `pcodx` MCP path labelled as sidecar-only
  - update docs and receipts to reject claims of Codex transcript shrink
    from MCP-only runs
- phase two
  - harden controller continuation
  - preserve task file, tmux target, run dir, session id, and continue command
  - ensure report helper instructions survive compaction
- phase three
  - improve controller tool parity with normal Codex
  - broker approvals or clearly constrain unsupported operations
  - keep shrink checks in the verifier
- phase four
- only if Codex exposes a native transcript replacement API
  - replace controller fresh-thread rendering with direct current-thread
    history rewrite

non-goals for the next worker

- no deletion of OpenCode plugin code
- no claim that MCP sidecar compaction shrinks stock CLI live context
- no redesign based only on artifact size
- no acceptance without token evidence from native Codex/app-server visibility
