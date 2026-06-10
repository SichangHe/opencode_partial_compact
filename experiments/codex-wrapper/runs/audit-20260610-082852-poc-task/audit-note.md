# codex wrapper poc audit note

run id: audit-20260610-082852-poc-task

task: diagnose demo-repo production payment timeout, compact stale discovery, continue after compaction

success criteria:
- visible-before-compaction.txt contains raw stale legacy context
- visible-after-compaction.txt contains a <compacted> block and omits raw stale legacy context
- ledger.json records the compacted range and the post-compaction continuation
- final-report.md recommends lowering production requestTimeoutMs below upstreamDeadlineMs
- key-evidence.txt points to the exact receipt lines

audit worker task:
inspect experiments/codex-wrapper/runs/audit-20260610-082852-poc-task, compare receipts with experiments/codex-wrapper/src/{demo.ts,ledger.ts,mock-adapter.ts,app-server-adapter.ts}, and judge whether the wrapper actually removed stale raw context before continuation
