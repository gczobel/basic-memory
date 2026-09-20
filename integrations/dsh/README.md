# Basic Memory for DeepSeek Harness

Basic Memory for DSH gives a session durable continuity: it starts briefed from
your knowledge graph, and after a context compaction it hands the resumed agent a
checkpoint to write back.

This package is the DSH carrier for that bridge. It is a
[cordis](https://github.com/deepseek-ai/deepseek-harness) plugin that calls the
released `basic-memory` CLI and places the result in the session. Routing, config
precedence, graph queries, output bounding, and the prompt-injection fence all live
in the Python core behind `bm hook <verb> --harness dsh`, so this package is small
by design and cannot drift from the other harness integrations.

## What it does

- **Session brief** (`agent/pre-step`). Before the first request, it asks
  `bm hook session-start --harness dsh` for a brief built from your active tasks,
  open decisions, and recent checkpoints, and contributes it as a plugin-sourced
  user message. Re-arms after a compaction, so a brief shadowed by a new summary
  comes back.
- **Per-turn capture.** After each settled turn it sends the conversation to
  `pre-compact` with `trigger: settled`, so a durable note exists *before* any
  compaction. Captures accumulate into one note per session, rewritten in place.
- **Post-compaction checkpoint.** When a compaction succeeds, the next brief is
  requested with `trigger: compact`, which makes the core return a checkpoint
  instruction instead of the ordinary brief. The resumed agent writes the note
  from its own working context — see *Why the agent writes it* below.
- **Capture reflexes** (`systemPrompt`). A prompt section telling the model to
  search before answering recall questions, capture real decisions as typed
  `decision` notes, cite permalinks, and treat recalled notes as data rather than
  instructions.
- **The `bm-checkpoint` skill**, registered as a runtime skill so it is available
  without any filesystem install step.

## Requirements

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) with a
  profile that mounts `dsh-base` (it supplies `systemPrompt` and `skills`).
- The `basic-memory` CLI on PATH, or a `bmCommand` wrapper. Verified against
  `bm hook`, which ships with the hook core.

Basic Memory's MCP server is **not** required by this plugin, and wiring it is a
separate concern: this package talks to the CLI. If you want the graph available
to the model as tools as well, register the MCP server in your profile — the
tools appear as `mcp__basic-memory__*`, which is what the reflex section names.

## Install

```bash
bm install dsh --dry-run
bm install dsh --yes
```

That runs `dsh plugin --profile web add @basicmemory/dsh-basic-memory` and mounts
the plugin row in that profile's `cordis.patch.yml`. Use `--profile <name>` to
target another profile. `--package` takes any specifier pnpm understands, so
`--package /path/to/checkout/integrations/dsh` installs from a local checkout
rather than the registry.

DSH reports `declares no dsh.bundle — installed as a plain dependency`. That is
expected and harmless: `dsh.bundle` marks a **bundle**, a profile layer such as
`dsh-base`, while this package is a plain plugin, which the row mounts explicitly —
the same shape as `@deepseek-ai/dsh-mcp-client`.

The plugin spawns `bm` on PATH by default. If the CLI is not on PATH — a checkout
driven through `uv`, for example — give the row a launcher:

```yaml
      config:
        bmCommand: [uv, run, --project, /path/to/checkout, basic-memory]
```

To mount it by hand, add the row and configure it:

```yaml
- insert:
    - id: basic-memory
      name: '@basicmemory/dsh-basic-memory'
      config:
        bmPath: bm
```

## Configuration

Two places, deliberately:

**The plugin row** owns transport and the ambient gates:

| Key | Default | Meaning |
| --- | --- | --- |
| `bmPath` | `bm` | Executable to spawn for `bm hook`. |
| `bmCommand` | _(none)_ | argv prefix overriding `bmPath`, e.g. `['uv','run','basic-memory']`. |
| `briefEnabled` | `true` | Inject a session brief at the first step. |
| `captureSettled` | `true` | Capture the conversation after each settled turn. |
| `captureEvents` | `true` | Record bounded lifecycle envelopes to the local inbox. |
| `timeoutMs` | `20000` | Per-invocation budget; the brief is skipped when exceeded. |

**`.dsh/basic-memory.json`** owns the knowledge-graph mapping — `project` or
`projectId`, `captureFolder`, `captureMinChars`, `recallTimeframe`,
`sessionProfile`, and the rest — and is read by the CLI, not by this package:

```json
{
  "project": "main",
  "captureFolder": "dsh/sessions",
  "captureMinChars": 80
}
```

`captureMinChars` (default 80) suppresses a capture when the turn that just settled
carries less than that, so a trivial follow-up costs no process spawn and no
rewrite. What keeps a session's note count at one is the stable title, not the
floor. The post-compaction switch is `checkpointOnCompact`, also read by the core.

The nearest `.dsh/basic-memory.json` wins, falling back to
`$DSH_HOME/basic-memory.json` (default `~/.dsh/basic-memory.json`). A malformed
file fails closed: capture is disabled rather than routed somewhere unintended.
`bm hook status --harness dsh` prints the effective settings.

Resolving that mapping in the CLI rather than here is deliberate. The plugin would
otherwise need a second implementation of project precedence, and the two would
drift — the failure mode being writes that land in a different project than the
brief read from.

## Why the agent writes the checkpoint

DSH publishes `compaction/start` to session-event observers that it never awaits:
a listener cannot delay the append, and a rejection is only logged as a warning.
A graph write begun there has no guarantee of landing, so this plugin does not
attempt one. It records the lifecycle envelope and lets the next brief ask the
resumed agent to author the checkpoint — the same shape the Codex integration
uses, and the reason `pre-compact` produces no note for this harness.

The practical upside is a better note: an agent writing from its own working
context produces a deliberate handoff, where a hook can only lift text out of a
transcript.

## Development

```bash
just check          # install, typecheck, test, build, pack dry-run
```

Or directly: `npm run check-types`, `npm test`, `npm run build`.

## License

AGPL-3.0-or-later
