# pcodx recovery index

purpose

- compact handoff tree for OPC supervisor work
- scope
  - explain current OpenCode partial compaction
  - explain PCODX Codex paths
  - identify why MCP-side compaction is not Codex transcript shrink
  - define the next redesign target

read order

- `current-implementation.md`
  - architecture map and tricky boundaries
- `critique-and-redesign.md`
  - why current PCODX does not shrink a normal Codex live context
  - redesign whose success criterion is controller-owned app-server shrink
- `retain-quarantine.md`
  - code to keep before deletion
  - code to quarantine or delete
- `next-worker-prompt.md`
  - exact implementation-worker prompt for the manager

main conclusion

- OpenCode plugin code is a valid partial-compaction implementation for OpenCode
  - reason
    - it runs inside OpenCode's message transform path before model dispatch
- PCODX MCP sidecar code is not a valid live Codex compaction implementation
  - reason
    - it changes only a ledger and artifacts outside Codex's hidden native transcript
- the useful Codex direction is controller-owned turns through `codex app-server`
  - reason
    - the controller can start each future turn from a compacted render
    - shrink is observable in app-server `thread/tokenUsage/updated`
