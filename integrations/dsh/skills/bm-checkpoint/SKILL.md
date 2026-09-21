---
name: bm-checkpoint
description: Save a deliberate work checkpoint to Basic Memory with the story, changed files, verification, decisions, blockers, and the next action. Use when the user asks to checkpoint, wrap up, hand off, or remember the state of the work, or when the session asks for one after a compaction.
---

# Checkpoint the work

Create a durable handoff note for the current work in Basic Memory. This is the note
a later session resumes from, so write it for a reader who returns weeks later, not
as a status dump.

## Choose the destination

The notes live on whichever server this session is connected to, so ask it. Call
`list_memory_projects`. One project is the destination. With several, use the one this
session has been working in, and ask the user when that is not clear rather than
guessing.

## Gather

- the problem or goal, and why it mattered
- the approach taken and why it solves the problem
- the current state and its practical impact
- `git status --short`, the current branch, the repository root, and the Git SHA
- the pull request number, title, state, and base/head when one exists
- the files actually changed, and the checks actually run
- decisions made, blockers left open, and the single next action

Never claim a check passed unless you ran it or the user reported the result.

## Write

Call `mcp__basic-memory__write_note` with:

- `title`: `DSH checkpoint - <short topic>`
- `directory`: `dsh/sessions`
- `tags`: `["dsh", "checkpoint"]`
- `note_type`: `session`, the shared type. Placement stays host-specific, but the type
  is what travels: a checkpoint typed `session` is one every other host's brief can
  recall, which a host-private type would not be.
- `metadata`:
  - `status: open`
  - `project: <the destination project>`
  - `cwd: <working directory>`
  - `started: <ISO timestamp>`
  - `capture: deliberate`
  - `agent: dsh`
  - `session_id: <the host's session id>`, when you have one

Begin the body with `# <the note title>`.

Then use the fields the Session schema declares, as observations:

- `[summary]` one concrete sentence, not a restatement of the title
- `[context]` what a reader needs in order to resume
- `[next_step]` the next concrete action; always at least one
- `[decision]` each durable choice
- `[problem]` what went wrong, including approaches tried and rejected
- `[produced]` notes created or updated, as wikilinks

Two more are worth having and the schema does not name them: `[verification]` for what
you actually ran, and `[changed_file]` when a path matters. The schema validates in
warn mode, so they are accepted as written.

Omit empty categories rather than writing "None". Put graph edges under a
`## Relations` section using relation syntax (`- relates_to [[Existing Note]]`), never
as `[relates_to]` observations, and only when the target note exists.

## Confirm

Reply with the permalink and the one next action the checkpoint preserves.
