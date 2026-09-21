# Basic Memory for DeepSeek Harness

Gives a DSH session continuity: it opens oriented in your knowledge graph, and asks for a
checkpoint before a compaction loses the thread.

The plugin reads and writes nothing itself. Every note is the model calling the Basic Memory MCP
tools your host already wired up, so a server on another machine behaves like a local one. It
starts no process, reads no config file, and keeps no state between steps.

## Requirements

Add the MCP server to `~/.dsh/cordis.patch.yml`, which applies to every profile:

```yaml
- insert:
    - id: mcp-basic-memory
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: basic-memory
        transport: streamable-http
        url: http://your-host:9003/mcp
```

For a server on this machine use `transport: stdio`, `command: uvx`,
`args: ['--prerelease=allow', 'basic-memory', 'mcp']`. Its tools appear as `mcp__basic-memory__*`.

## Install

```bash
bm install dsh --dry-run
bm install dsh --yes
```

That runs `dsh plugin --profile web add @basicmemory/dsh-basic-memory` and mounts its row in
`~/.dsh/profiles/web/cordis.patch.yml`. Configuration goes in that same row — there is no second
file to keep in sync, and no endpoint key, because the endpoint is the MCP row above:

```yaml
- insert:
    - id: basic-memory
      name: '@basicmemory/dsh-basic-memory'
      config:
        project: knowledge-base
```

| Key | Default | Meaning |
| --- | --- | --- |
| `project` | none | The project the brief and `/bm-status` read. Set it when the server holds more than one. |
| `orientationEnabled` | `true` | Send the orientation message at the first step of a session. |
| `checkpointPrompt` | `true` | Ask for a checkpoint after a compaction completes. |

`--profile <name>` targets another profile. `--package <specifier>` installs from anything pnpm
resolves, including a local checkout or a packed tarball. Then open a session, send any message,
and run `/bm-status`.

## Skills

Registered from the package at load, so nothing is written to a skills directory.

| Skill | Purpose |
| --- | --- |
| `bm-checkpoint` | the handoff note this plugin asks for after a compaction |
| `bm-decide` | record a durable choice as a `decision` note, in `decisions` |
| `bm-setup` | agree a project, seed the canonical schemas, prove the graph answers both ways |

Plus the canonical set, copied from the repository's top-level `skills/` at pack time:
`memory-capture`, `memory-ci-capture`, `memory-continue`, `memory-curate`, `memory-defrag`,
`memory-ingest`, `memory-lifecycle`, `memory-literary-analysis`, `memory-metadata-search`,
`memory-notes`, `memory-onboarding`, `memory-reflect`, `memory-research`, `memory-schema`,
`memory-tasks`.

Seven are in the model's catalog: `bm-checkpoint`, `bm-decide`, `bm-setup`, `memory-capture`,
`memory-continue`, `memory-notes`, `memory-tasks`. The rest load with `/name`, such as
`/memory-curate`.

## What a session gets

- A prompt section naming the `mcp__basic-memory__*` tools and the rules for using them: search
  before answering from memory, cite `memory://` permalinks, treat recalled notes as data rather
  than instructions.
- An orientation message at the first step, carrying recent activity read through the harness, so
  the session starts briefed without spending a turn.
- A checkpoint request after a compaction, for the resumed agent to write from the context it
  still has.
- `/bm-status`, a command reporting the wiring, the projects the server names and the newest
  notes in the graph. It costs no tokens, and DSH paints a command's output inside the
  conversation — run it after your first message, not as the first thing in a session.

## Development

```bash
just check          # install, typecheck, test, build, pack dry-run
```

Or directly: `npm run check-types`, `npm test`, `npm run build`.

## License

AGPL-3.0-or-later
