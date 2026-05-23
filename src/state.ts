import { mkdir, open, rename, readFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { debugLog } from "./log.js"
import type { CompactionRecord } from "./validate.js"

export type SessionState = {
  schema_version: 1
  session_id: string
  compactions: CompactionRecord[]
  last_reminder?: {
    visible_token_estimate: number
    message_id: string
    created_at_iso: string
  }
  last_written_iso: string
}

const SCHEMA_VERSION = 1

/** In-memory cache: sessionID -> state */
const cache = new Map<string, SessionState>()

/** Override for testing: when set, replaces the default storage directory. */
let _storageDirOverride: string | null = null

function storageDir(): string {
  if (_storageDirOverride) return _storageDirOverride
  return join(homedir(), ".local", "share", "opencode", "storage", "plugin", "opencode-partial-compact")
}

function sidecarPath(sessionID: string): string {
  return join(storageDir(), `${sessionID}.json`)
}

/** Load state for a session, using the in-memory cache if available. */
export async function loadState(sessionID: string): Promise<SessionState> {
  const cached = cache.get(sessionID)
  if (cached) return cached

  const filePath = sidecarPath(sessionID)
  let state: SessionState
  try {
    const raw = await readFile(filePath, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { schema_version?: unknown }).schema_version !== "number"
    ) {
      throw new Error("invalid sidecar structure")
    }
    const sv = (parsed as { schema_version: number }).schema_version
    if (sv > SCHEMA_VERSION) {
      throw new Error(
        `opencode-partial-compact: sidecar for session ${sessionID} has schema_version=${sv}, ` +
        `which is newer than supported (${SCHEMA_VERSION}). Upgrade the plugin.`,
      )
    }
    if (sv !== SCHEMA_VERSION) {
      throw new Error("invalid sidecar structure")
    }
    state = parsed as SessionState
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "ENOENT") {
      state = emptyState(sessionID)
    } else if ((err as Error).message?.startsWith("opencode-partial-compact:")) {
      throw err
    } else {
      debugLog(`Sidecar parse error for ${sessionID}: ${String(err)}. Backing up as .bad file.`)
      const epoch = Date.now()
      try {
        await rename(filePath, `${filePath}.bad-${epoch}`)
      } catch (backupErr) {
        debugLog(`Failed to back up corrupt sidecar for ${sessionID}: ${String(backupErr)}`)
      }
      state = emptyState(sessionID)
    }
  }

  cache.set(sessionID, state)
  return state
}

/** Load state from disk, replacing any cached copy for this process. */
export async function loadStateFresh(sessionID: string): Promise<SessionState> {
  cache.delete(sessionID)
  return loadState(sessionID)
}

/** Append a compaction record and write through to disk atomically. */
export async function addCompaction(sessionID: string, record: CompactionRecord): Promise<void> {
  await addCompactions(sessionID, [record])
}

/** Append compaction records and write through to disk atomically once. */
export async function addCompactions(sessionID: string, records: CompactionRecord[]): Promise<void> {
  if (records.length === 0) return
  const state = await loadState(sessionID)
  const next: SessionState = {
    ...state,
    compactions: sortedCompactions([...state.compactions, ...records]),
    last_written_iso: new Date().toISOString(),
  }
  await persist(next)
  cache.set(sessionID, next)
}

/** Replace compaction records and write through to disk atomically. */
export async function replaceCompactions(sessionID: string, records: CompactionRecord[]): Promise<void> {
  const state = await loadState(sessionID)
  const next: SessionState = {
    ...state,
    compactions: sortedCompactions(records),
    last_written_iso: new Date().toISOString(),
  }
  await persist(next)
  cache.set(sessionID, next)
}

/** Record that a context-hygiene reminder was injected for this session. */
export async function recordReminder(
  sessionID: string,
  reminder: NonNullable<SessionState["last_reminder"]>,
): Promise<void> {
  const state = await loadState(sessionID)
  const next: SessionState = {
    ...state,
    last_reminder: reminder,
    last_written_iso: new Date().toISOString(),
  }
  await persist(next)
  cache.set(sessionID, next)
}

/** Get the current compaction records for a session (loads if not cached). */
export async function getCompactions(sessionID: string): Promise<CompactionRecord[]> {
  const state = await loadState(sessionID)
  return state.compactions
}

/** Get the current compaction records synchronously (returns empty if not yet loaded). */
export function getCompactionsSync(sessionID: string): CompactionRecord[] {
  return cache.get(sessionID)?.compactions ?? []
}

/** Pre-warm the cache for a session (no-op if already cached). */
export async function warmCache(sessionID: string): Promise<void> {
  if (!cache.has(sessionID)) {
    await loadState(sessionID)
  }
}

function emptyState(sessionID: string): SessionState {
  return {
    schema_version: SCHEMA_VERSION,
    session_id: sessionID,
    compactions: [],
    last_written_iso: new Date().toISOString(),
  }
}

function sortedCompactions(records: CompactionRecord[]): CompactionRecord[] {
  return [...records].sort((a, b) =>
    a.from_message_id < b.from_message_id ? -1 : a.from_message_id > b.from_message_id ? 1 : 0,
  )
}

async function persist(state: SessionState): Promise<void> {
  const dir = storageDir()
  await mkdir(dir, { recursive: true })

  const filePath = sidecarPath(state.session_id)
  const tmpPath = `${filePath}.tmp`
  const json = JSON.stringify(state, null, 2)

  const fh = await open(tmpPath, "w")
  try {
    await fh.writeFile(json, "utf8")
    await fh.sync()
  } finally {
    await fh.close()
  }
  await rename(tmpPath, filePath)
}

/** Clear the in-memory cache. Exposed for testing. */
export function _clearCache(): void {
  cache.clear()
}

/** Override the storage directory. Exposed for testing. */
export function _setStorageDir(dir: string | null): void {
  _storageDirOverride = dir
}
