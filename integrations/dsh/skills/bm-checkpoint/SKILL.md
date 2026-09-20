---
name: bm-checkpoint
description: Save a deliberate work checkpoint to Basic Memory with the story, changed files, verification, decisions, blockers, and the next action. Use when the user asks to checkpoint, wrap up, hand off, or remember the state of the work, or when the session asks for one after a compaction.
---

# Checkpoint the work

Create a durable handoff note for the current work in Basic Memory. This is the
deliberate counterpart to the automatic pre-compaction trace, and the note a
later session resumes from.

## Gather

Resolve the destination from the workspace config the hooks read: the nearest
`.dsh/basic-memory.json`, falling back to `$DSH_HOME/basic-memory.json`. A
`project` or `projectId` there routes the write; `captureFolder` (default
`dsh/sessions`) places it.

Collect evidence before writing:

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
- `directory`: the configured capture folder
- `tags`: `["dsh", "checkpoint"]`
- `note_type`: `dsh_session`, or `coding_session` when `sessionProfile` is `coding`
- `metadata`: `status: open`, `project`, `cwd`, `started`, `capture: deliberate`,
  `agent: dsh`, and the session id when the host supplied one

A checkpoint is a handoff, not a status dump. Tell the story for a reader who
returns weeks later: what the problem was, what changed, how it was verified, and
what to do next. Prefer durable observations over narrative duplication:

- `[result]` for concrete outcomes
- `[decision]` for each durable choice
- `[blocker]` for each unresolved blocker
- `[next_step]` for the next concrete action; always include at least one
- `[verification]` or `[changed_file]` only when the item is itself project memory

Omit empty categories rather than writing "None". Put graph edges under a
`## Relations` section using relation syntax (`- relates_to [[Existing Note]]`),
never as `[relates_to]` observations, and only when the target note exists.

## Confirm

Reply with the permalink and the one next action the checkpoint preserves.
