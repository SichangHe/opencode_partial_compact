import { runCuratedLiveTurnSmoke } from "./app-server-adapter.js"

const cadenceProbe = "x ".repeat(18000)
const visibleContext = [
  "partial compaction wrapper live-turn probe",
  "",
  "Find timeout issue.\n<aboveturn id=\"msg1\"/>",
  "",
  "stale README and legacy audit were checked and are not production evidence.\n<pcodx-compacted id=\"cmp1\" range=\"msg2..msg4\" />",
  "",
  "production config requestTimeoutMs=12000 upstreamDeadlineMs=9000\n<aboveturn id=\"msg5\"/>",
  "",
  `cadence threshold probe payload: ${cadenceProbe}\n<aboveturn id="msg6"/>`,
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
