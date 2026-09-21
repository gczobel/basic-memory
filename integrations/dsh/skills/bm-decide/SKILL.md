---
name: bm-decide
description: Record a durable decision in Basic Memory with rationale, alternatives, and consequences. Use when the user makes a real choice, asks to record one, or runs /bm-decide.
---

# Record the decision

A decision is a choice with alternatives and a rationale, not a preference. If the rationale
or the alternatives are missing, ask rather than invent them. The subject does not matter:
a product, research or personal choice is a decision note in exactly the same way an
implementation choice is.

The notes live on whichever server this session is connected to, so ask it: call
`list_memory_projects`. One project is the destination. With several, use the one this
session has been working in, and ask the user when that is not clear rather than guessing.
Asking here is right even though the session opens without asking: writing is where a wrong
answer costs something.

## Steps

1. Read the project's Decision schema with `read_note` (`schemas/decision`, which `bm-setup`
   seeds) and follow the fields it declares.
2. Search first — `search_notes(metadata_filters={"type": "decision"})` — for a decision this
   one replaces, and update that note rather than writing a second one.
3. Write with `write_note`: `note_type`: `decision`, `directory`: `decisions`, the schema's
   frontmatter passed as `metadata` (`status: open` unless the user says otherwise, plus
   `decided`), and the body as `content`. Frontmatter written inside `content` reaches the
   cloud write path as `[object Object]`.
4. Relate the note to the work it affects, and to the decision it supersedes.
5. Read it back and cite the permalink.

The note belongs to the graph, not to the agent that wrote it: keep it in `decisions`, use the
schema's own fields, and add no tag, folder or marker naming the harness. Another agent reads
it or supersedes it, and it should not be able to tell which one wrote it.
