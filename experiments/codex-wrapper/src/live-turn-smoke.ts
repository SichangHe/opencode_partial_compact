import { runCuratedLiveTurnSmoke } from "./app-server-adapter.js"

const cadenceProbe = "x ".repeat(18000)
const visibleContext = [
  "<system>partial compaction wrapper live-turn probe</system>",
  "",
  "<message id=\"msg000001\" role=\"user\">Find timeout issue.</message>",
  "",
  "<compacted id=\"cmp000001\" range=\"msg000002..msg000004\">stale README and legacy audit were checked and are not production evidence.</compacted>",
  "",
  "<message id=\"msg000005\" role=\"tool\">production config requestTimeoutMs=12000 upstreamDeadlineMs=9000</message>",
  "",
  `<message id="msg000006" role="tool">cadence threshold probe payload: ${cadenceProbe}</message>`,
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
