import { runCuratedLiveTurnSmoke } from "./app-server-adapter.js"

const cadenceProbe = "x ".repeat(18000)
const visibleContext = [
  "partial compaction wrapper live-turn probe",
  "",
  "Find timeout issue.\n<pcodx-message id=\"msg000001\" role=\"user\" />",
  "",
  "stale README and legacy audit were checked and are not production evidence.\n<pcodx-compacted id=\"cmp000001\" range=\"msg000002..msg000004\" />",
  "",
  "production config requestTimeoutMs=12000 upstreamDeadlineMs=9000\n<pcodx-message id=\"msg000005\" role=\"tool\" />",
  "",
  `cadence threshold probe payload: ${cadenceProbe}\n<pcodx-message id="msg000006" role="tool" />`,
].join("\n")

const prompt = [
  "Using only the injected context, answer in one sentence.",
  "Treat requestTimeoutMs greater than upstreamDeadlineMs as a bug.",
  "What timeout fix should be made?",
  "Do not run tools.",
].join(" ")

const result = await runCuratedLiveTurnSmoke(visibleContext, prompt)
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exit(1)
