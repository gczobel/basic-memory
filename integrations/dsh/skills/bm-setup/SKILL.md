---
name: bm-setup
description: Set up Basic Memory for this project — confirm the server is wired, agree which project to use, and add the canonical note schemas. Use when the user asks to set up or repair Basic Memory, when the memory tools are missing, or when typed notes have no schema.
---

# Set up Basic Memory

There is nothing to configure. The server comes from the host's MCP row and the project
is chosen here. Setup confirms those two things, adds the note schemas, and proves the
wiring works in both directions.

## 1. Are the tools there?

Look at your own tool list for the Basic Memory tools, named `mcp__basic-memory__*`. If
they are missing, stop here: this host has no MCP row for Basic Memory. Hand the user
the row and nothing else.

```yaml
- insert:
    - id: mcp-basic-memory
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: basic-memory
        transport: streamable-http
        url: http://your-host:9003/mcp
```

`transport: stdio` with `command: uvx` and `args: ['--prerelease=allow', 'basic-memory', 'mcp']`
is the local equivalent. Nothing below applies until those tools exist.

## 2. Which project?

Call `list_memory_projects`. With one project, confirm it. With several, ask which one
this work belongs in, and pass it as `project` on every write below. Do not guess, and
do not create a project as part of setup.

Then tell the user where to record it, because the plugin cannot write host
configuration itself: the plugin row for their profile, in the `cordis.patch.yml` the
harness loads, gains a `project` key with that name.

```yaml
- insert:
    - id: basic-memory
      name: '@basicmemory/dsh-basic-memory'
      config:
        project: knowledge-base
```

With that set, the session brief reads from that project and a mechanically written
capture has an unambiguous destination. Without it, the model still asks before
writing, and the brief covers every project the server reports.

## 3. Add the schemas, with approval

Ask first, once: "Add the canonical note schemas (Session, Decision, Task) to <project>?
They declare the shape of the notes that checkpoints and decisions are written as."
Proceed only on a yes.

Then for each file beside this skill, in the base directory the harness named:

- `references/session.md` for checkpoints
- `references/decision.md` for choices with a rationale
- `references/task.md` for structured work items
- `references/coding-session.md` only if this project tracks repository-scoped work

Check each type first with `search_notes`
(`metadata_filters={"type": "schema"}`) or `read_note("schemas/session")`, and **skip any
type that already has one**. Never overwrite a schema the user may have customized, and
never add a second schema for the same type.

For each type that is missing, call `mcp__basic-memory__write_note` with
`directory="schemas"`, `note_type="schema"`, the schema's own title, and the file's
structured frontmatter as `metadata`: `entity`, `version`, the `schema` map and
`settings` as nested values, with enum lists as JSON arrays. Pass the markdown **body
only** as `content`, never the `---` block. Nested YAML inside `content` is coerced to
the string `'[object Object]'` on the cloud write path, which corrupts the schema;
`metadata` round-trips correctly.

## 4. Prove it works

Read one seeded schema back with `output_format="json"` and `include_frontmatter=true`,
and check that `schema` and `settings` return as nested objects rather than strings.
Then confirm the graph answers in the other direction too: run a `search_notes` with
`page_size=1` and report what came back.

## Report

Keep it short: the project this session will use for checkpoints, the schemas you added
with their permalinks, the ones you skipped and why, and anything still broken.
Checkpoints land in `dsh/sessions` as notes typed `session`.
