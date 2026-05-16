import { appendFileSync } from "node:fs"

let _path: string | null = null

/** Configure the debug log path. Pass null to disable. */
export function setLogPath(p: string | null): void {
  _path = p
}

/** Write a debug line. No-op if no log path configured. */
export function debugLog(msg: string): void {
  if (!_path) return
  const line = `[opencode-partial-compact ${new Date().toISOString()}] ${msg}\n`
  try {
    appendFileSync(_path, line)
  } catch {
    // best-effort
  }
}
