# Critique Findings (Opus Max Review)

Independent skeptical review of the first-draft design. Items below are
load-bearing and must be reflected in the next revision of the docs and
in the implementation. Source critique preserved in
`/tmp/claude-30033/.../tasks/ac99028f6108171d1.output` (subagent
transcript).

## P0 — Will break or won't work

### C1. `pc_peek` round-trip silently defeats compaction

Current spec: peek returns originals as a tool result that does NOT
re-inline into the persistent view (`20-agent-tools.md`). Wrong: a
`tool_result` part IS persisted into `PartTable` by Opencode and gets
re-fed on every subsequent call. The peeked content lives in the
model's view forever, at a position newer than our compaction marker,
near the cache breakpoint — doubling the cost. Model also sees both
summary and originals and may get confused about which is canonical.

**Fix.** Either (a) make peek ephemeral via the transform hook for
exactly the next call only (never persisted, injected as a synthetic
system note), or (b) drop `pc_peek` for v0 and let the agent ask the
user / search again if it needs to recover originals.

**Recommendation:** drop for v0 (b). Add back as ephemeral injection
in v0.1 if the agent demonstrably needs it.

### C2. Cache break-even math was wrong for middle-of-history

Doc claimed "~2 future turns" break-even. Reality: compacting in the
middle invalidates everything from the cache breakpoint forward. On
turn N+1 you re-pay ~1.25× write price on the *entire* new prefix
(say 45k of 50k), not just the compacted 5k.

**Corrected estimate.** Break-even M ≈ (prefix_after_compaction ×
1.15) / (tokens_saved × 0.9). For a 5k compaction in a 50k context,
M ≈ 11 turns, not 2.

**Implication.** The "agent unrestricted, just nudge" stance (OQ-4) is
under-defended. We must:
- Make the cache cost honest in the tool description so the agent can
  do the math.
- Optionally annotate the tool result with an estimated break-even so
  the agent can self-correct.
- Tail-region compactions (close to the breakpoint) really are cheap,
  but the spec needs to distinguish.

### C3. DCP coexistence: "use one or the other" is not workable

Users install plugins by adding strings to an array. Nothing tells them
the two will produce double tag-injection and conflicting IDs.

**Fix.** Detect DCP at `server()` invocation (check `ctx.config.plugin`
or resolved registry). Refuse to load with a clear error and a doc
pointer.

### C4. Tag injection on every call is fragile under future drift

If the hook output ever becomes a non-pure function of (log, sidecar)
— for instance a future field populated from `Date.now()` — cache hit
rate craters silently. Listed as F4 but treated as discipline.

**Fix.** Add a byte-stability snapshot test as a precondition for the
compaction logic landing. Two consecutive `transform` calls on the
same fixture must produce byte-identical output.

### C5. In-place mutable hook contract is not formally pinned

Opencode happens to share the array reference across plugins today.
There is no test / doc pinning this. A future refactor that
`structuredClone`s before each subscriber would break us and DCP
silently.

**Fix.** File an upstream issue pinning the contract and ideally PR a
doc comment to `prompt.ts` (the call site of
`experimental.chat.messages.transform`).

### C6. Hook order == plugin array order is an assumption

Documented internally but not asserted in Opencode's public API.

**Fix.** Same upstream issue as C5. In-plugin, do still emit a
load-time check warning users when the order is wrong.

### C7. Auto-expansion of tool pairs can swallow reasoning

Current spec auto-expands a compaction range to include partner parts.
But the partner's message may also contain assistant text not in the
original range — we silently compact reasoning the agent wanted to
keep.

**Fix.** Default `pc_compact` to **reject** ranges that split a tool
pair. Make `auto_expand: true` an explicit opt-in arg.

## P1 — Will work but are over-engineered

### O1. `pc_restore`

Niche operation; cost = guaranteed cache miss; agent can always emit a
new turn that re-states the forgotten info. Drop for v0.

### O2. `pc_list`

Once exposed, agents will spam it as a substitute for thinking. Drop.
The same info can be exposed via tag injection on the synthetic parts.

### O3. Dual ID granularity (accept both `prt...` and `msg...`)

Model must learn when to use each. Pick **part-level only** for v0;
document with one example.

### O4. Separate `pc_id` namespace

The first part ID in the range is already a unique handle. Use it as
the compaction's key. Saves: ID generator, an attribute on the
synthetic part, a sidecar column.

### O5. Sidecar JSON

Reconstructible state `[{range, summary}]` — should be persisted
through Opencode's normal `CompactionPart` mechanism instead. The
`filterCompactedEffect` machinery already exists and is what gets us
upstreamability.

**Implication.** Re-read the existing `compaction.ts` and
`message-v2.ts:filterCompactedEffect` more carefully. If we can
piggyback on `CompactionPart` with a custom `kind` discriminator, we
remove F5 (sidecar corruption) and F10 (concurrent writers)
entirely.

### O6. Warning on plugin order

Apply the same hardness as C3: error, don't warn.

## P2 — Lower-stakes

### L1. Tag injection should be opt-in, not default-on

Cuts steady-state per-part token overhead. Agents that need IDs can
turn it on; most can figure out IDs from the inline summary parts
alone.

### L2. Don't trust the agent to do the cache math without help

Either gate by age relative to breakpoint, or annotate the
`pc_compact` result with a break-even estimate, or both.

## Missing design questions (OQ-11..OQ-16)

- **OQ-11.** Reward-hacking: does the agent over-compact when it
  knows it's being evaluated on context length?
- **OQ-12.** UX when user runs `/compact` while our state references
  pre-compact part IDs. Need user-visible status, not silent skip.
- **OQ-13.** Sub-agent interaction (`call_omo_agent`). Does the
  parent see anything? Disjoint sessions?
- **OQ-14.** Streaming/interrupted turn: `pc_compact` mid-stream,
  session aborts before persistence. Sidecar (or new equivalent) and
  SQLite disagree.
- **OQ-15.** Does the model copy `prt...` IDs into file edits or
  shell commands because they look like content? Evaluate via a
  short agent run.
- **OQ-16.** Upgrade path when Opencode changes `PartID` format.

## Trivial-alternative recommendation from critique

> `pc_compact(message_id, summary)` only — message-level, no peek, no
> restore, no list, no tags. 200 LoC instead of 1500. 80% of the token
> savings, none of F1/F3/F11/peek-roundtrip failure modes.

**Strongly suggested starting point for v0.** Adding parts /
peek / restore later, only when a real session shows the gap.

## What I will do next

1. Wait for empirical-run subagent to finish.
2. Email user with this critique + the v0-trivial-alternative
   recommendation, ask if we should pivot to that or stay with the
   richer design (perhaps with C1..C7 fixed).
3. After user input, do the consolidated doc rewrite in one pass.
4. Then implement.
