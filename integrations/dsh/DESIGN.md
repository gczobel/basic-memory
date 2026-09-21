# Basic Memory for DeepSeek Harness

This package connects a DSH session to the user's Basic Memory graph. It orients
the model at the start of a session, asks for a checkpoint after a compaction, and
ships the skill that says what a checkpoint is.

It never reads or writes a note. The model does that, through the Basic Memory MCP
server the host has configured.

Measured against DSH `0.1.1-rc.2`.

## Why it does not use the hook core

Claude Code and Codex get their context from `bm hook`, which reads the graph
through the local CLI. That holds while the CLI and the MCP server are the same
installation, and nothing keeps them the same. Point the host at a server on
another machine and the hook reads a different, usually empty project. The session
gets no orientation, and a capture lands in the wrong graph. Neither side reports
an error.

The plugin cannot repair that from where it sits. `bm hook` never learns the host's
MCP endpoint, and giving the plugin its own MCP client would mean writing the note
policy a second time, in TypeScript.

So this plugin contributes prompt text and nothing else. Where the graph lives is
the host's business.

## What it contributes

- A standing prompt section naming the `mcp__basic-memory__*` tools, telling the
  model to search the graph before answering from memory and to cite permalinks.
- An orientation message at a session's first step: call `recent_activity`, do not
  stop to ask which project to use, and cite permalinks. It carries a brief of recent
  activity when the plugin can read one, and names the project when the row pins one.
- A checkpoint request after a compaction completes.
- The skills, registered from the package at load: `bm-checkpoint`, which its own
  checkpoint flow names, plus the canonical `memory-*` set.
- A brief of recent activity, read through the host's tool registry and attached to
  the orientation message.

## Skills

A session gets the whole memory workflow, not just the checkpoint step, so the
package ships the canonical skills alongside its own.

The source of truth for those skills is the repository's top-level `skills/`
directory, and this package carries a generated copy: `npm run fetch-skills` copies
every `memory-*` directory into `skills/`, `prepack` runs it before a publish, and
the copy is gitignored so the repository holds one copy. The Pi and OpenClaw packages
do the same.

The copy exists because a published package cannot reach outside itself. npm ships
only what is inside the package directory, and it does not follow symlinks out of it,
so linking the canonical skills rather than copying them is not an option.

The plugin registers whatever it finds in that tree, so adding a skill upstream needs
no change here. `bm-checkpoint` is the one it requires, and a package missing it says
so through the host logger.

Seven of them are model-invocable: `bm-checkpoint`, which the checkpoint flow names,
`bm-setup`, whose offer has to be actionable, `bm-decide`, which has to answer a real choice
in the session where it is made, and `memory-notes`, `memory-capture`, `memory-continue` and
`memory-tasks`, which is the set the Pi package carries. The rest stay user-invocable only, so
they ship and remain one `/name` away without sitting in the model's catalog. Measured: the
seven names and descriptions come to about 450 tokens, against about 1,300 for all eighteen. A
skill outside the catalog is not hidden: typing `/memory-curate` loads it in full.

A skill that ships companion files carries a `resourceBase`, which the harness renders
into the loaded content as a base directory. `memory-onboarding` is the one that needs
it: it directs the model to read `references/conventions.md` and three siblings, and
without a base those are paths the model cannot resolve. Skills whose `SKILL.md` stands
alone carry none, so nothing is claimed about resources that do not exist.

`bm-setup`, `bm-decide` and `bm-status` are written here rather than copied. Together they
are the shape the other hosts use: a setup flow the user runs, a way to record a choice, and a
report of what is wired.

`bm-decide` follows the seat the other hosts fill differently - Claude Code and Codex each ship
a `bm-decide` skill and Tau a `bm-decide` prompt - and it is deliberately thin, the way Tau's
is. It carries the procedure, not the shape: the fields, the `status` lifecycle and the recall
query stay in the canonical Decision schema, which `bm-setup` seeds into the graph. The note is
placed in `decisions` with the schema's own fields and no marker naming this host, because the
agent that supersedes a decision is not necessarily the one that wrote it.

Setup settles the two things only the user can, which project this work belongs in and
whether to add the canonical note schemas, and then proves the graph answers in both
directions. It is model-invocable because the offer has to be actionable: the model asks,
the user agrees, the same session does the work. The schema files ride beside it, so
setup offers the real schema rather than one recalled from memory, and a type that
already has a schema is never touched.

`/bm-status` is a command rather than a skill, because every fact in it belongs to the
plugin. It reads the same log the plugin reads, so it can state what was injected and
when; a model asked to recall that would answer wrongly after a compaction, once the
injected message has been shadowed. It reports the registered tools, the projects the
server names, what the plugin has said this session, and the newest notes the graph holds.

The harness renders a command's result in the UI and keeps it out of model history, so a
status check costs no tokens and no turn. That also means the model cannot read the report
and cannot be asked to act on it; it is the user's view of the plugin's own state.

The command service is looked up with `ctx.get` rather than injected: a profile with no
command adapter would refuse to load a plugin that required it, and a missing command is
better than a missing plugin. Verified against `0.1.1-rc.2`: `ctx.get("commands")` answers
without an `inject` declaration, while the typed `ctx.commands` property throws `cannot get
property "commands" without inject`. The lookup is therefore the only form that works here.
When no service answers, registration warns in the harness log, because the alternative is
a slash command that silently does nothing.

Both live reads go through `bridgedToolName` before they are called. A bridged server
registers `mcp__<serverName>__<tool>`, so the bare name is not callable: the first version
asked for `list_memory_projects` outright and the harness answered `unknown tool
"list_memory_projects"`.

The newest-notes line reads `recent_activity`, not `search_notes`, and that is a constraint
rather than a preference. A search payload cannot cross the harness at all: its results
carry `score: -0`, and the host rejects a value JSON cannot round-trip, since
`JSON.stringify(-0)` is `"0"` and the sign is lost. Every search type fails this way - text,
vector and hybrid all returned `-0` for the session notes here - so the call dies with
`value is not lossless JSON` before the plugin sees anything. Recent activity returns a
title and permalink per note and validates. Search stays in the package only as an anchor
for the wired-server check, which asks whether a name is registered, never what it returns.

A failure inside the report carries its reason. `callTool` returns the result or the reason
there is none, and the two callers read that differently: the session brief treats a failure
as "no brief this time" and stays quiet, while the status command prints the message, since
a report that only says `unavailable` leaves its reader exactly where the failure did.

The plugin nudges only where it can see the problem itself. When the registry holds no
Basic Memory tool at all, the orientation message says the server is not wired and gives
the row to add. When the registry cannot be read, it says nothing, because a guess about
the wiring is worse than silence. It does not probe for schemas: that needs a project,
and the project is chosen by the model inside the session, after the plugin's last word.

## What it relies on

**A plugin can call a registered tool.** `ctx.tools.execute(exec)` resolves the tool
as the given agent sees it, runs the full policy pipeline, and returns `{ isError,
content, value }`. It appends nothing to the session log, so a call the model did not
make stays out of the transcript. Verified live against DSH `0.1.1-rc.2`, reading a
remote server's notes through the host's connection.

**`agent/pre-step` is where a plugin contributes context.** The listener runs as a
waterfall and passes `{ prepend: true }`, so its message lands before the step's
own.

**The session log is readable, and the plugin's state comes from it.**
`agent/pre-step` carries the agent, the agent carries its session, and
`session.events` is an append-only snapshot. At pre-step time it holds everything
through the open `turn/start`. Reading that log rather than remembering is what the
harness's own `dsh-time-context` does, recognizing its earlier messages by
`source.plugin`. Its README gives the reason: it survives a resume with no
process-local cache.

**DSH forwards MCP tools and nothing else.** `dsh-mcp-client` registers tools
without reading the server's `instructions`, prompts, or resources. Basic Memory
ships its session-start guidance in `instructions`, so on DSH that text reaches
nobody, which is why the plugin says it itself.

**Only a successful compaction appends `compaction/summary`.** A failed attempt
closes with `compaction/end` and shadows nothing, so the summary event is the one
that means the visible history was replaced.

**DSH does not await session-event observers.** A write started on that channel
cannot be ordered against a compaction, so there is no durable pre-compaction write
to be had there. The checkpoint is therefore authored by the resumed agent, which
has the summary in context.

**The plugin's own surface is a message plus a read.** It contributes text to the step,
and it reads through the registry. It cannot speak MCP itself, and it writes nothing:
orchestration and every note write stay with the model.

## The brief

The orientation message carries recent activity from the graph, read by the plugin
itself. One call, against the wall clock, so the session starts knowing what changed
instead of spending a turn finding out.

That read goes through the harness tool registry, `ctx.tools.execute`, which routes
it over the MCP connection the host already owns. The plugin therefore needs no
endpoint, no transport, and no knowledge of where the server runs, and the same code
works for a stdio server and one on another machine.

The tool is found by name rather than assumed: a bridged server registers
`mcp__<serverName>__<tool>`, and the server name comes from the host's MCP row, so the
plugin looks for a registered tool called `recent_activity`, however it is prefixed.

The reference is a read, so it carries no note policy. Writing is different, and that
is why the checkpoint stays with the model: a title, a folder and a note type are
decisions, and putting them here would duplicate in TypeScript what `bm hook` already
does in Python.

Everything about it fails open. No registry, no signal, no such tool, an error result,
a rejected call or empty text each leave the instruction message on its own, and the
brief is capped so a large project cannot flood a session's first step.

The brief rides on the orientation, so a session resumed with its history intact is
not briefed again. The standing section carries what matters beyond that, and a
compaction is covered by the checkpoint request.

## The capture
Not yet built. This is the design it will be built to.

A note the plugin writes by itself, at the end of a turn, out of that session's own
turns. It is the counterpart to the deliberate checkpoint: raw material rather than
judgement, recorded so a session that dies before it checkpoints still leaves a trace.
The shared Session schema already provides for it, with `capture: extractive` among its
values, which is how the Claude Code hook types the notes it writes.

It writes only where the destination is unambiguous:

- `project` is set, so there;
- `project` is not set and the server reports exactly one project, so there;
- otherwise it writes nothing. Several projects and no key means the choice is the
  user's, and the plugin will not make it for them.

The note carries `capture: extractive`, `agent: dsh`, `status: open`, the session's
working directory and start, and a stable title per session, so a long session rewrites
one note rather than accumulating them.

What it will not do is infer. The project the model chose is recoverable from the
arguments recorded on its tool calls, and that is inference from side effects: it breaks
silently when a field is renamed, and it is the coupling this package avoids everywhere
else. Asking the user for the one fact the host cannot supply is the honest version.

## Flow

```
session starts
  plugin  adds the orientation message
  model   calls recent_activity, picks a project, reads and writes notes over MCP

compaction completes
  plugin  adds the checkpoint request to the next step
  model   loads bm-checkpoint and writes the note over MCP

every request
  the standing section names the tools and the cite-permalink rule
```

The brief is read through `ctx.tools.execute`, over the host's own MCP connection:

```
plugin  calls mcp__<server>__recent_activity   (one call, 7d, capped)
plugin  fences the text as data and attaches it to the orientation message
model   starts already knowing what moved, and needs no call to find out
```

## When the project is asked about

Reading is safe wherever the server points, so the orientation does not ask. Writing is not:
a note in the wrong project is the silent failure this package exists to remove, so the
question is asked at the write, by the skill doing the writing, and only when the server
holds more than one project and none is pinned.

The first version asked at the door instead - the orientation told the model to list
projects and ask which to work in whenever the server held more than one. That interrupts
the user before they have asked for anything, in the one moment the answer cannot matter
yet, and it asked even when the row pinned a project, since the instruction never looked at
it. The pin is the once-and-done answer, and `bm-setup` is where it is agreed.

## How it decides what to say

The plugin keeps no state. Each step reads the log backwards and decides from it.

The orientation is owed until one has been said at all in this session.

The checkpoint is owed whenever the newest compaction is later than the newest
checkpoint message. Positions in the log decide that, not counts, because a tally can
be wrong: a message the plugin contributed to a step that the harness then rejected
never reaches the log, so counting messages would show an ask that never happened.
Positions also mean any compaction re-arms the request, however many came before it.

The two are independent, so a session compacted before the plugin has said anything
gets both messages.

A compaction does not re-arm the orientation. The standing section is rebuilt on every
request and no compaction can shadow it, so the durable half is never lost, and the
checkpoint request is what that moment needs.

Finding its own messages works because each carries the plugin name and a section name
in its source attribution. Nothing else distinguishes them, so the orientation cannot
be taken for the checkpoint. Reading the log this way is not novel: the harness's own
`dsh-time-context` recovers its earlier injections the same way.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `orientationEnabled` | `true` | Add the orientation message at the start of a session |
| `checkpointPrompt` | `true` | Add the checkpoint request after a compaction |
| `project` | none | Where a mechanical capture writes, and what the brief reads from when set |

`project` is the one thing the plugin cannot work out for itself, because the host has
no idea which project a session belongs to. Every sibling package names it the same way:
`primaryProject` in Claude Code and Codex, `project` in Tau, Pi, OpenClaw and Hermes.
Claude Code's documentation is explicit that without it its PreCompact hook writes
nothing, which matches its code: `_pre_compact` returns when no project is pinned.
Codex documents the fallback instead, leaving the project argument unset so Basic
Memory picks its default. Hermes goes furthest, taking `project` or `project_id` on
every tool call so the agent can route a single write elsewhere without reconfiguring.

There is no endpoint key. The endpoint belongs to the host's MCP row, and the plugin
reads the graph through the registry rather than needing to know where it lives.

**Nothing here infers configuration from behaviour.** Where a fact is not available
through a documented channel, the feature that needs it is left out rather than guessed
at.

An unknown key in the row is ignored, so a stale one does not stop the plugin
loading. A gate written as anything but a boolean is reported through the host
logger and the default stands, since YAML makes `"false"` easy to write.

## Alternatives considered

**Reading the graph through `bm hook`.** The path Claude Code and Codex take. It
needs the hook-side CLI to resolve the same graph as the host's MCP server, and
with a remote server it does not.

**Giving the plugin an MCP client.** It would let the plugin fetch a brief and write
captures itself, at the cost of a second implementation of note policy: titles,
folders, note types, overwrite rules.

**Per-turn capture, dropped and then re-decided.** An earlier revision did without it
on the grounds that the deliberate checkpoint covers the same work with more thought in
it. That is true of the content and false of the coverage: a session that dies before it
compacts, or a model that ignores the checkpoint request, leaves nothing, and Claude
Code's hook is a writer that cannot be ignored. The capture is designed in its own
section above, and the thing that blocked it was never the write.

**Inferring the project from the model's tool calls.** The log records the arguments of
every call, so the project a session used is recoverable without asking. Rejected: it
reads a side effect rather than a contract, and a renamed field would silence it without
anyone noticing. The `project` key is the honest version of the same thing.

**Serving the server's `instructions`, prompts, or resources.** DSH's MCP client
does not consume them, so there is nothing on the plugin side to hook into.

**A project key, or an endpoint key.** Both are knowledge the host already has. A
copy in the plugin row is a second place for the same answer to go stale.

**Keeping per-session state in the plugin.** A `WeakMap`, or a file under
`DSH_HOME`. A reload discards the first, and the second is the only thing this
package would own on disk. The session log already holds the answer and survives
both a reload and a resume.

## Limitations

**A command's output is invisible in a session with no turn yet.** DSH builds a command's
result into a conversation node from the `command/run` and `command/done` pair in the log, and
the conversation view is what paints it, so with no turn there is no surface for it and the
report stays unseen. Nothing is lost: three runs in a turn-less session showed nothing, and
all three appeared at once after the next message. Every command behaves this way, `/compact`
included, so this is the host's gap rather than this plugin's, and the README documents it
where the command is described.

The workarounds were weighed and rejected. Injecting a message when the agent is created makes
the session non-empty and so paints the report, but it taxes every session with a message
nobody wrote and its tokens, and it reaches past the `agent/pre-step` seam that plugins are
given. A client UI half is how the harness itself shows anything outside a turn — the
`dsh-client-ui-*` packages, each paired with a host package through a typed remote and shipped
as a built browser bundle - and following that pattern means a second package, a bundler and a
wire contract, which is far too much machinery to print a status report.

**Checkpoints are typed `session`, not a host-private type.** Placement stays in
`dsh/sessions`, but the type is the shared one, so a checkpoint this host writes is
recallable by every other host's brief. A private type is invisible to them, and that
costs more than sharing the namespace.

**No per-turn trace.** Nothing writes a note between compactions, so a session that
ends without one leaves nothing in the graph. DSH keeps every session event in its own
jsonl file, so the turns are still on disk, just not in the graph.

**The checkpoint request waits for a step.** `/compact` runs no model turn, so the
request arrives with the next step. A session compacted and then abandoned is never
asked.

**No project pinning.** With more than one project on the server the model asks which
to use. A user who wants a workspace pointed at one project has no way to say so.

**The messages are instructions, not mechanisms.** A model can ignore them, and the
plugin cannot tell whether it did. The Claude Code and Codex integrations stand on the
same footing.

## Tests

`test/plugin.test.ts` covers what reaches the model and when, including that a
reload re-orients nothing and that another plugin's message is not mistaken for
ours. `test/config.test.ts` and `test/skills.test.ts` cover the config boundary and
the skill loader.

Two tests guard the shape of the package: it starts no process and keeps no
in-memory store.

`tests/cli/test_install_dsh.py` covers `bm install dsh` against a temporary
`DSH_HOME`.

What the tests cannot reach: whether a model acts on the orientation message, and
whether a real compaction is followed by the request. Both need a live session.
