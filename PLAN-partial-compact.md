# PLAN: Opencode Partial Compaction Plugin

## User's instructions (verbatim, condensed)

The user wants a new Opencode plugin that works alongside `oh-my-openagent`
implementing **agent-driven partial compaction** of the context window.

Key properties (user's own words / clarifications):

- "the agent to decide when to compact and do partial compaction automatically"
- "after running a CLI command and getting a long output, the agent would
  summarize the output and replace it with the summary in the context window"
- "local replacement, so we keep most of the KV cache"
- "Claude Code `unwind` 'summary from here', except with much more checkpoints
  (not just user prompts) and let agent able to do it itself"
- "Turns 2–40 are replaced by the summary in the LLM's view" — correct
- NOT called checkpoint; it's **partial compaction**
- NOT threshold-driven (e.g., 60% full); should be done **greedily whenever the
  agent thinks it does not need to remember something**
- Example 1: agent reads 15 files, decides 3 matter; replaces 12 reads with one
  line note that they are irrelevant.
- Example 2: agent edits → broken → fix → validate; replaces whole sequence
  with "Edited foo.ts correctly. Tests pass."
- Each turn should have an incrementing ID; agents replace/delete by ID;
  agents can still refer back to original content of each turn by ID after
  compaction.
- Implementation should be a new plugin alongside `oh-my-openagent`, not
  modifying it. Modifying Opencode itself is allowed if needed.

## Deliverables

1. **Hierarchical design doc set** in this repo laying out a concrete
   implementation plan.
2. **Preliminary experiments** validating context-window manipulation in
   Opencode (must prove the approach works at the plugin level, or document
   why a fork is required).
3. **Email user** for design-choice questions and progress updates.
4. **Implementation** of the plugin once design is approved.

## Constraints / context

- Reference projects (already cloned, sibling dirs):
  - `../anomalyco--opencode/` — Opencode
  - `../code-yeongyu--oh-my-openagent/` — companion plugin to coexist with
  - `../Opencode-DCP--opencode-dynamic-context-pruning/` — similar prior effort
  - `../youngbinkim0--oh-my-opencode/` — another sibling
- This repo (`/ssd1/sichangheagent/opencode_partial_compact/`) is empty
  except for a fresh git repo.
- Working language for Opencode plugin: TypeScript (Opencode is TS/Bun).
- Use Sonnet medium subagents for bulk research; Opus max (this agent) for
  planning + synthesis.

## Phase plan

### Phase 0: Discovery (no implementation)

- P0.1 Map Opencode's message/context/session architecture: where is the
  context window assembled, how are messages persisted, how is compaction
  currently done (if at all), what plugin/hook points exist.
- P0.2 Map oh-my-openagent: how it integrates with Opencode (plugin shape),
  how it gives the agent tools, any namespacing patterns.
- P0.3 Survey Opencode-DCP: what they tried, what worked, what didn't, and
  why. Use this to avoid repeating mistakes.
- P0.4 Identify exact extension points: tool registration, message
  transformation hooks, session save/load hooks. Decide: pure plugin vs.
  fork-or-PR-to-Opencode.

### Phase 1: Design (with user check-ins)

- D1 Write top-level `docs/00-overview.md` summarizing the system.
- D2 Sub-docs:
  - `docs/10-turn-log-model.md` — immutable log + mutable view architecture
  - `docs/20-agent-tools.md` — exact tool API the agent uses (compact/
    delete/restore/peek by ID)
  - `docs/30-opencode-integration.md` — where we hook in
  - `docs/40-kv-cache-strategy.md` — how to preserve provider prompt cache
  - `docs/50-persistence.md` — how original turns are stored and retrieved
  - `docs/60-coexistence.md` — interplay with oh-my-openagent
  - `docs/70-failure-modes.md` — what breaks (e.g., over-compaction,
    referencing deleted IDs, cache invalidation)
- D3 Ask user on each open design question before locking it.

### Phase 2: Validation experiments

- E1 Confirm we can intercept and rewrite the message array sent to the LLM
  from a plugin (no fork). If we cannot, document the specific block.
- E2 Confirm tool calls from the agent can mutate the persisted session
  representation (so compaction survives reloads).
- E3 Confirm KV cache survives intended rewrites (provider behaviour
  matters — Anthropic prompt cache has prefix semantics; rewriting an old
  turn invalidates everything after, so we need to think about ordering).

### Phase 3: Implementation

- (Deferred until design + experiments approved.)

## STUCK / LOOP / CHECK / STOP discipline

- **STUCK**: reflect, doubt assumptions, run smaller tests, reread this PLAN,
  redo from first principles.
- **LOOP**: after each natural pause, reread + update this file, delete done
  items, continue.
- **CHECK**: after writing code, run strong static checks + tests.
- **STOP**: when no TODOs left, do a skeptical code-review pass (or use
  subagent). Only delete PLAN when fully done.

## Email discipline

- Use `~/.config/helper.sh/email_me.py`.
- Include PWD in every email.
- Never repeat email body in printout.

## Current state / open questions to ask user

OQ-1. Should partial compaction operate over **turns** (one user prompt +
   one assistant response + tool calls) or over individual **message
   parts** (a single tool result, a single assistant message)?
   - Finer = more flexibility but more state to manage; coarser = simpler
     mental model.
OQ-2. When the agent "summarizes" content, who writes the summary?
   - (a) The agent itself, inline, as part of the tool call payload.
   - (b) A separate cheap model invocation triggered by the tool call.
   - (c) Either, agent's choice.
OQ-3. Should `restore` (undo a compaction) be exposed as a tool, or is
   compaction one-way (originals always queryable via `read_turn(id)` but
   never re-inlined)?
OQ-4. KV-cache: if rewriting old turns invalidates the prefix, do we accept
   the cost (do it anyway because we'll reuse the new prefix), or do we
   restrict compaction to a sliding "old enough that cache is gone anyway"
   window?
OQ-5. Plugin-only vs. fork: if plugin hooks are insufficient, prefer
   (a) submitting a PR to Opencode adding the hook, or (b) maintaining a
   fork? User has said "modify anything you want" so both are on the table,
   but a PR is cleaner.

## TODO

- [x] Set up PLAN file.
- [x] Discovery (Opencode, oh-my-openagent, DCP).
- [x] First-draft design doc set + open-questions email.
- [x] POC experiment built, type-checked, and run inside live Opencode 1.14.46.
- [x] Opus max critique → `docs/02-critique-findings.md`.
- [x] User round-2 reply (Q-A..Q-E all answered, trivial v0 approved).
- [x] Consolidate docs to v0 spec.
- [ ] Persistence spike (CompactionPart piggyback vs sidecar) — Sonnet
      subagent running, timeboxed 1 hr.
- [ ] Lock `50-persistence.md` per spike outcome.
- [ ] Implement plugin (`src/`, `test/snapshot.test.ts` first as F4
      precondition, then `pc_compact` tool, then hook).
- [ ] Manual smoke-test inside live Opencode (already-loadable via
      project-local opencode.json).
- [ ] CHECK + STOP review.

## State as of latest LOOP

- Discovery done.
- First-draft design doc set: docs/00..70 + README + 01-open-questions.
- POC compiled, type-checked, AND **successfully run inside production
  Opencode 1.14.46** via project-local `opencode.json` and a `file://`
  URI. Hook fires, mutation works, tool visible to model. Sidecar
  evidence in `/tmp/pc-poc.log`.
- **Opus max critique** identified P0 design bugs (especially `pc_peek`
  round-trip silently defeats compaction; cache break-even math wrong
  for middle-history) + P1 over-engineering (drop `pc_restore`,
  `pc_list`, dual-ID, sidecar). Captured in
  `docs/02-critique-findings.md`.
- Second email sent: pivot recommendation to trivial v0
  (`pc_compact(from_message_id, to_message_id, summary)` only,
  CompactionPart persistence, no tag injection), plus open questions
  Q-A..Q-E. **Blocked on user reply** before consolidating docs and
  implementing.
- After user response:
  - depending on Q-A: either rewrite docs to reflect trivial v0, or
    apply C1..C7 corrections to the richer design.
  - depending on Q-B: spike Opencode `CompactionPart` reuse, or commit
    to sidecar.
  - begin implementation.
