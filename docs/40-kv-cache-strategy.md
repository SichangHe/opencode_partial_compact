# KV / Prompt-Cache Strategy (v0, corrected)

Earlier draft put break-even at "~2 future turns" universally. That was
wrong for middle-of-history compactions; corrected below.

## Where Anthropic's cache breakpoints sit

`packages/opencode/src/provider/transform.ts:340..388` — `applyCaching`
attaches `cache_control: { type: "ephemeral" }` to:

- the **first two system messages**
- the **last two non-system messages**

Runs **after** our hook, on the post-compaction array.

## What invalidates on a rewrite

A cached prefix is reused iff the **exact** token sequence up to a
breakpoint matches a prior request. Any byte change before a breakpoint
invalidates everything cached at and after that breakpoint.

Two regions matter:

| Region | What happens on compaction | Cost on next turn |
|---|---|---|
| Tail (≤ last 2 non-system messages) | Breakpoint moves with us; the changed bytes are after the system breakpoint but before the new last-2 breakpoint. | Effectively free — those tokens weren't cached separately anyway. |
| Middle (between system breakpoint and last-2 breakpoint) | The whole prefix from system breakpoint forward changes shape. | Full re-cache. Re-pays ~1.25× write price on the entire post-system prefix. |

## Honest break-even

Let:
- `T_save` = tokens removed by the compaction.
- `T_prefix_new` = total tokens in the post-compaction prefix from
  system breakpoint forward.
- `r_write ≈ 1.25 × base`, `r_read ≈ 0.1 × base` (Q1 2026
  Anthropic prices; recheck before publishing public numbers).

Cost on next turn (vs. no compaction):

```
extra_cost ≈ T_prefix_new × (r_write - r_read)
           = T_prefix_new × 1.15 × base
```

Savings per turn N+2 onward:

```
saving_per_turn ≈ T_save × r_read
               = T_save × 0.1 × base
```

Break-even M ≈ `(T_prefix_new × 1.15) / (T_save × 0.1)`
             ≈ `(T_prefix_new / T_save) × 11.5`.

Worked example: 5k compaction in a 50k context, post-compaction prefix
~45k. M ≈ `(45 / 5) × 11.5 ≈ ~103` turns. **Way more than the "~2"
the earlier draft claimed.**

For tail compactions, `T_prefix_new` is effectively 0 for the
invalidation calculation (the breakpoint moves with us), so break-even
M ≈ 1 turn.

## What v0 does about this

- Tool description tells the agent: prefer recent unneeded content;
  middle-history rewrites are expensive. No enforcement.
- We do **not** annotate the tool result with a break-even estimate in
  v0. v0.1 may. (Reason: we don't have visibility into the agent's
  expected remaining session length, so any estimate would be
  uncertain.)
- We do **not** gate by age relative to the breakpoint. The agent has
  more context than we do; a one-off "I'm about to start a totally
  different task and won't need any of this" is a valid reason to
  compact deep history.

## What we don't do (out of scope)

- Custom `cache_control` placement. AI-SDK middleware owns it; would
  need a new hook in Opencode core. Maybe a v0.2 upstream PR.
- Re-ordering for cache. Anthropic matches the literal byte prefix;
  re-ordering doesn't help.

## The F4 invariant (cache stability)

Our hook MUST be a pure function of (log, state). Same inputs → byte-
identical output. The snapshot test in `test/snapshot.test.ts` runs
the hook twice on a fixture and byte-compares. This test is a
precondition for any new logic landing in `hook.ts`.
