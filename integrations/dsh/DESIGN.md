# Basic Memory for DeepSeek Harness — Design

**Status:** first PR
**Scope:** the DSH integration only. Related: [Pi](../pi/README.md),
[OpenClaw](../openclaw/README.md), [Claude Code](../../plugins/claude-code/DESIGN.md).

## 1. Positioning

DSH is an agent host, like Claude Code, Codex, and Pi. Basic Memory already serves
those three through one shared hook core behind `bm hook <verb> --harness <name>`.

This integration makes DSH the fourth host. It is a **carrier**: it contributes a
session brief, a post-compaction checkpoint prompt, a prompt section, and a skill
— and delegates every decision to the shared core.

The plugin deliberately holds no memory logic. It spawns
`bm hook <verb> --harness dsh`, reads the text from stdout, and places it in the
session. Settings precedence, graph queries, output bounds, and the
prompt-injection fence stay in one place, in one language, tested once.

## 2. Verified findings

Measured against DSH `0.1.1-rc.2` and the `0.23.2` checkout, by mounting throwaway
cordis plugins into a profile and running `dsh --profile headless`. The traces are
the primary source; see §8.

| # | Question | Verdict | Evidence | Design consequence |
|---|---|---|---|---|
| Q1 | Can a third-party plugin load without an npm install? | **confirmed** | An absolute `name:` in a `--patch` overlay loaded directly. A plugin needs no imports from `@deepseek-ai/*` to publish a valid message — DSH's own `dsh-repeat-tool-reminder` inlines the same helpers | The package carries one runtime dependency, `schemastery`, for the config schema only |
| Q2 | When is a plugin able to contribute context? | **confirmed** | `agent/pre-step` fires with the downstream decision; appending a message to an `enter` decision reached the model on its first request | The brief is injected there, not at session creation |
| Q3 | Are harness services reachable without declaring them? | **confirmed, with a trap** | Without `inject`: `Error: cannot get property "systemPrompt" without inject` | `inject: ["systemPrompt", "skills"]` |
| Q4 | Can skills ship without a filesystem install? | **confirmed** | `ctx.skills.register({name, description, content})` works; DSH's frontmatter vocabulary (`name`, `description`, `disable-model-invocation`) already matches the other integrations | `bm-checkpoint` registers as a runtime skill, read from the package at load |
| Q5 | Does DSH await session-event observers? | **refuted** | `compaction/end` was appended at 8.8 s while a listener with a 25 s timer was still pending. Source agrees: `invokeContainedSessionObservers` does `Promise.resolve(returned).catch(...)` with no `await`, so a rejection becomes a log warning | **The central decision.** DSH writes no checkpoint from a lifecycle hook (§4.2) |
| Q6 | Do message events carry the conversation? | **confirmed** | `user/message` → `{content, source, role, id}`; `assistant/message` → `{turn, step, message, usage}`. The real prompt arrives with `source.kind == "user"`; the AGENTS.md baseline arrives as `agent-instructions` | Per-turn capture can read the conversation from the documented event channel (§7) |
| Q7 | What is reachable from the session object? | **confirmed** | `session.log` is an array of `{type, seq, time, data}`; `session.derived`/`derivedNodes` hold the model-visible fold; `header` is `{version, id, createdAt, cwd}` — **no model field** | `session.log` is not used (§7). The model comes from the agent's options, not the header, so a `session-start` payload carries the model while a `pre-compact` one does not |
| Q8 | Does a failed compaction look like a successful one? | **confirmed no** | A refused compaction closed with `compaction/end {error: "summary is not smaller than the shadowed content (654 … >= 46)"}` and appended no `compaction/summary` | Only `compaction/summary` marks the brief stale |
| Q9 | Does DSH forward MCP server instructions? | **refuted** | `dsh-mcp-client` has no reference to `instructions`, `prompts/list`, or `resources/list` — it registers tools only. Basic Memory ships its own session-start orientation in the MCP `instructions` field | The brief layer is load-bearing here, not a convenience. Raw MCP capability arrives; the orientation behaviour does not |

## 3. Architecture

Three seams, plus the CLI:

| Seam | Fires | Contributes |
|---|---|---|
| `agent/pre-step` | before each step | the brief, as a plugin-sourced snapshot message |
| `session/event` | on every log append | compaction observation; the lifecycle envelope |
| `systemPrompt.section` | prompt assembly | the capture reflexes (order 150) |
| `skills.register` | plugin load | the `bm-checkpoint` skill |

```
agent/pre-step ──▶ plugin ──spawn──▶ bm hook session-start --harness dsh
                     │                        │
                     │                        ├─ adapter normalizes the payload
                     │                        ├─ settings: .dsh/basic-memory.json
                     │                        ├─ graph queries: tasks, decisions, sessions
                     │                        └─ brief: fenced, bounded, with a recall prompt
                     ◀────── stdout: the brief ─┘
                     │
                     └─▶ appended to the entering batch → the model's first request
```

## 4. Decisions

### 4.1 Configuration is split by ownership

The plugin row owns **transport and gates** (`bmPath`, `bmCommand`,
`briefEnabled`, `captureSettled`, `captureEvents`, `timeoutMs`).

`.dsh/basic-memory.json` owns the **knowledge-graph mapping** (`project`,
`captureFolder`, `recallTimeframe`, `sessionProfile`, …) and is read by the CLI,
not by the plugin.

A second implementation of project precedence in TypeScript would drift, and the
failure mode is severe: writes landing in a different project than the brief read
from. One resolver, in the language that owns the note writer.

### 4.2 DSH writes no checkpoint from a lifecycle hook

Claude Code's `PreCompact` is synchronous with a 600-second budget, so its hook can
write a note before compaction proceeds. Pi can too: its extension calls the CLI
itself and supplies the turns.

DSH gives the opposite guarantee (Q5). A write begun on `compaction/start` cannot
delay the compaction, cannot be ordered against it, and fails into a log warning.
Building a durable checkpoint on that channel would be a race with no visibility
into whether it was won.

So the checkpoint is authored by the **resumed agent**. After a successful
compaction the plugin asks for the next brief with `trigger: "compact"`, and the
core answers with a checkpoint instruction instead of the ordinary brief. This is
the existing Codex path, reused rather than reinvented.

### 4.3 The brief is keyed on the compaction count

A plugin message is durable history. A successful compaction shadows it. An
once-per-session flag would silently lose the brief forever after the first
compaction, so injection is keyed on how many successful compactions the session
has seen. The value the visible brief was built at becomes stale, and the brief is
rebuilt.

Only `compaction/summary` increments the count (Q8).

### 4.4 Fail-open, and its limit

A hook must never fail a step. The Python core has `_run_fail_open`; the plugin
returns the downstream decision untouched on any error, and `bm.ts` resolves
`undefined` on every failure path so the caller skips its contribution.

The limit: fail-open must not hide a bug a developer needs to see. Each swallow
site is deliberate and narrow — a spawn that cannot launch, a non-zero exit, an
aborted signal. A failure that indicates a *broken invariant* is not swallowed.

### 4.5 The plugin reads documented channels only

`session.log` holds the full event history, including events compaction has
shadowed (Q7). Reading it would let the checkpoint recover text the summarizer
dropped.

It is not used. It is an own property of `Session`, not a documented extension
point, and a third-party package depending on it would be a stability risk across
releases. The documented `session/event` channel carries the same text (Q6).

## 5. Vocabulary

Three words are overloaded across the two domains. This document uses them as
follows, and the code follows it.

| Word | Here it means | Not |
|---|---|---|
| **session** | a DSH session: the event-sourced log and its surface | a Basic Memory `session` note |
| **checkpoint** | the note a session writes so a later one can resume. DSH distinguishes the *compaction checkpoint* (DSH's own summary) from the *Basic Memory checkpoint note* | the compaction checkpoint alone |
| **hook** | the lifecycle event a host emits. `bm hook` is the CLI group that serves them; `hook.py` is the core | a git hook |

The Basic Memory domain language is `docs/DOMAIN_MODEL.md` — note, project,
permalink, canonical versus derived state. This document adds only the integration
vocabulary above, which that document does not cover.

## 6. Deferred, with a reconciliation plan

Three issues are known and not fixed here. Each is an existing condition, not
something this change introduces.

**6.1 The fence rule exists twice.** Python `_fence` in `hook.py` and Pi's
`recallFenceFor` in `integrations/pi/extensions/index.ts` implement the same
prompt-injection defence with different parameters — floor of 5 backticks versus 3,
and only Python collapses over-long runs and caps content before the closing fence.
Neither is exploitable alone, but two rules with one name will diverge.

*Plan:* follow the `integrations/shared/` precedent — schemas there are already a
canonical source with generated copies and a `--check` drift gate. Write the rule
down once, add language-neutral conformance vectors, and have both test suites read
the same file so `package-check` fails when they disagree.

**6.2 `preCompactCapture` is documented but inert.** The Claude Code plugin declares
it in five places and nothing reads it; `DESIGN.md` there says the default became
`summarized` while its docs say `extractive`.

*Plan:* implement it, or delete it from all five.

**6.3 Pi implements in TypeScript what belongs in Python.** A capture gate
(`captureMinChars`) and a full note builder in `captureSession()`, used when
`useHookFlow` is false.

*Plan:* one gate and one builder in Python; hosts report events. This is the same
principle as §1 and it is what makes the planned capture (§7) cheap to add for each
host.

## 7. Per-turn capture

A checkpoint written only after a compaction cannot recover what the summarizer
dropped (§4.2). So the plugin also captures during the session.

After each settled turn it reads the conversation from `session/event` (Q6) and
calls `pre-compact` with `trigger: "settled"`. Three rules make that safe:

**Turns come from the human, not the channel.** The `user/message` channel carries
the AGENTS.md baseline (`source.kind == "agent-instructions"`), tool results
(`"tool"`), and this plugin's own brief (`"plugin"`). Only `source.kind == "user"`
is the human talking, and only that is captured. Without the filter every
checkpoint would open with the workspace instructions.

**Captures accumulate into one note per session.** The core derives a stable
per-session title, so each capture rewrites the session's one note rather than
leaving a trail of fragments. What bounds the note count is that title, not the
floor below.

**The buffer is bounded to what the core reads.** The core reads the opening user
turn for the note's lead and the newest few for its tail; nothing reads the middle.
So the plugin holds the opening turn plus a capped tail, and captures are
serialized per session — two children racing would both rewrite one note, and an
earlier one finishing last would revert it to an older body.

**A floor skips trivial turns.** `captureMinChars` (default 80) suppresses a
capture when the turn that just settled carries less than that, so a one-word
follow-up does not cost a process spawn and a rewrite. It judges that turn, not the
session total: summing the conversation would make the gate inert from the second
turn onward.

The two layers do different jobs: the mechanical capture is the safety net for what
happened, and the agent-authored checkpoint after compaction is the judgement about
what matters.

## 8. Known limitations

**No backfill on resume.** A plugin sees only events after it loads, so a resumed
session's note starts partway through its history. `session.log` would fix it;
§4.5 explains why that is not used.

**The re-arm is blind to a compaction in a seeded log.** DSH does not republish
seeded events, so a session resumed after an earlier process's compaction starts
with a count of zero and asks for an ordinary brief instead of a checkpoint
request. The pre-compaction detail is already gone at that point. Deriving it would
again require `session.log`.

**Session note types are host-isolated.** DSH checkpoints are `dsh_session`, as
Codex's are `codex_session` and Pi's `pi_session`. A DSH brief therefore does not
recall a Claude Code checkpoint in the same project, because the profile queries
its own type. That is the existing convention, not a decision made here, but it
works against Basic Memory's promise of memory that is portable between AI tools,
and it is worth revisiting on purpose rather than by default.

**A capture failure is reported, not retried.** Each capture is fire-and-forget.
The plugin chains the next onto it, but nothing in the session waits for the
result, so a failure is logged once through the host logger and then that session
stops capturing. A broken CLI therefore costs one spawn rather than one per turn —
at the price of no capture for the rest of the session.

**Pi records a settled turn as a compaction.** Pi's extension reports its per-turn
captures through `pre-compact` too, and the core then writes a
`compaction_imminent` envelope for each. That is pre-existing behaviour, left alone
because this change is additive; DSH skips the envelope, because a settled turn is
not a compaction. Worth aligning when the capture policy is unified (§6.3).

## 9. Verification

- **Unit:** `tests/cli/test_dsh_hook.py` and `tests/cli/test_install_dsh.py`, plus
  the DSH section of `tests/hooks/test_adapters.py`. The behaviours the design
  rests on are pinned by tests rather than by this document: no note on the
  compaction trigger, one note per session on the settled trigger, and a skill
  whose note types match what the profile recalls.
- **Package:** `integrations/dsh` type-checks, builds, and passes its own suite;
  `just package-check-dsh` runs all of it, and CI runs it on every change.
- **Live:** the built package mounted into a headless DSH profile, with `bmCommand`
  pointed at the checkout, produced the DSH setup nudge in the model's reply — a
  string that exists only in the DSH profile in `hook.py`. That exercises the whole
  chain: plugin load, pre-step injection, the CLI spawn, the adapter, settings
  resolution, and the brief.
- **Prototype:** the probe plugins and the measurement traces are the primary source
  for §2. They are to be kept on a `prototype/dsh-verification` branch rather than
  deleted, so the claims above rest on a recording instead of a recollection.

## 10. Review outcomes

An independent adversarial review of this change found a functional defect and
several smaller ones, all fixed here. Recorded because each is a mistake worth not
repeating:

- The bundled skill wrote `note_type: session` while the DSH profile recalls
  `dsh_session`, so a DSH checkpoint would never have appeared in the brief's
  "where you left off" section. Now pinned by a test that compares the two.
- The plugin declared a `checkpointOnCompaction` config key that nothing read —
  the same defect this document criticises in the Claude Code plugin (§6.2). The
  key is gone; the core's `checkpointOnCompact` is the single switch.
- The plugin read the model from the session header, which has no such field, so
  `bm hook` could never receive it and a fixture asserted a payload the plugin
  could not produce. It now reads `agent.options.model`.
- Two tests could not fail for the regressions they named: one asserted only the
  absence of a write on a path that never writes, and another claimed a spawn
  count it never observed. Both now assert the thing they name.
- Every failure path was silent, so a broken or unreachable CLI produced no brief
  and no diagnostic. The plugin now reports the reason once through the host
  logger while still failing open.
- The README documented an install command that did not exist. `bm install dsh`
  now exists.
