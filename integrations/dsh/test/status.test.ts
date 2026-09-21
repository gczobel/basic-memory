/**
 * The status command: what it reports, and what it does when it cannot tell.
 *
 * Every fact here is the plugin's own, read from the log and the tool registry, so
 * these tests drive the handler with a session log rather than with a model.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { registerStatusCommand, type CommandResult, type StatusContext } from "../src/status.ts";

interface Registered {
  name: string;
  description: string;
  handler: (invocation: { agent?: unknown; signal?: AbortSignal }) => Promise<CommandResult>;
}

interface Harness {
  ctx: StatusContext;
  registered: Registered[];
  warnings: string[];
}

function fakeContext(options: { commands?: boolean; tools?: StatusContext["tools"] } = {}): Harness {
  const registered: Registered[] = [];
  const warnings: string[] = [];
  const services: Record<string, unknown> = {};
  if (options.commands ?? true) {
    services.commands = {
      register(definition: Registered) {
        registered.push(definition);
        return () => {};
      },
    };
  }
  return {
    ctx: {
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      get: (service: string) => services[service],
      logger: { warn: (message: string) => warnings.push(message) },
    },
    registered,
    warnings,
  };
}

const LABELS = {
  plugin: "basic-memory",
  orientation: "basic-memory:orientation",
  checkpoint: "basic-memory:checkpoint",
};

function makeTools(options: { names?: string[] } = {}): NonNullable<StatusContext["tools"]> {
  const names = options.names ?? [
    "mcp__basic-memory__recent_activity",
    "mcp__basic-memory__search_notes",
  ];
  return {
    schemas: () => names.map((name) => ({ name })),
    execute: (exec) =>
      Promise.resolve({
        isError: false,
        content: [{ type: "text", text: serverSays(exec.name) }],
      }),
  };
}

/** The text the real tools return, in the shape the command parses. */
function serverSays(name: string): string {
  if (name.endsWith("list_memory_projects")) {
    return "Available projects:\n- knowledge-base (local)\n- main (local)\n";
  }
  // The bare array the harness hands back from the text block; the wrapped `{result: []}`
  // form is the server's structured content, and both are read.
  return JSON.stringify([
    { title: "DSH checkpoint - docs", permalink: "knowledge-base/dsh/sessions/x" },
  ]);
}

function sessionWith(...events: { type: string; time: number; section?: string }[]): {
  session: { events: unknown[] };
} {
  return {
    session: {
      events: events.map((event) => ({
        type: event.type,
        time: event.time,
        data:
          event.section === undefined
            ? {}
            : { source: { kind: "plugin", plugin: "basic-memory", sections: [{ name: event.section }] } },
      })),
    },
  };
}

async function run(harness: Harness, agent: unknown): Promise<string> {
  const [command] = harness.registered;
  assert.ok(command, "a command was registered");
  const result = await command.handler({ agent, signal: new AbortController().signal });
  assert.equal(result.kind, "success");
  return result.text ?? "";
}

test("registers the command where a command service exists", () => {
  const harness = fakeContext();
  registerStatusCommand(harness.ctx, LABELS);

  assert.equal(harness.registered.length, 1);
  assert.equal(harness.registered[0].name, "bm-status");
  assert.ok(harness.registered[0].description.length > 0);
});

test("loads without a command service instead of failing, and says so", () => {
  const harness = fakeContext({ commands: false });
  registerStatusCommand(harness.ctx, LABELS);

  assert.deepEqual(harness.registered, []);
  // Silence here is how the command went missing once: the harness rejects an unknown
  // slash command and shows the user nothing, so the plugin has to say it.
  assert.deepEqual(harness.warnings, [
    "basic-memory: no command service in this composition, /bm-status is not registered",
  ]);
});

test("reports the tools, the graph and what the plugin has said", async () => {
  const tools = makeTools();
  const harness = fakeContext({ tools });
  registerStatusCommand(harness.ctx, LABELS);
  const agent = sessionWith(
    { type: "user/message", time: Date.UTC(2026, 8, 21, 14, 47, 12), section: "basic-memory:orientation" },
    { type: "compaction/summary", time: Date.UTC(2026, 8, 21, 15, 0, 0) },
    { type: "user/message", time: Date.UTC(2026, 8, 21, 15, 0, 1), section: "basic-memory:checkpoint" },
  );

  const text = await run(harness, agent);

  assert.match(text, /tools:       present, 2 registered/);
  assert.match(text, /plugin:      orientation at 14:47:12, checkpoint requests 1/);
  assert.match(text, /projects:    knowledge-base, main/);
  assert.match(text, /recent:      1 newest/);
  assert.match(text, /DSH checkpoint - docs — knowledge-base\/dsh\/sessions\/x/);
});

test("says nothing was said when the log holds no injections", async () => {
  const harness = fakeContext({ tools: makeTools() });
  registerStatusCommand(harness.ctx, LABELS);

  const text = await run(harness, sessionWith());

  assert.match(text, /plugin:      nothing said yet/);
});

test("reports a missing server without pretending to read it", async () => {
  const harness = fakeContext({ tools: makeTools({ names: ["mcp__other__search"] }) });
  registerStatusCommand(harness.ctx, LABELS);

  const text = await run(harness, sessionWith());

  assert.match(text, /tools:       missing/);
  assert.match(text, /graph:       unavailable, no Basic Memory tool is registered/);
});

test("calls the bridged tool names, and reads the graph for the configured project", async () => {
  const called: { name: string; args: Record<string, unknown> }[] = [];
  const tools = {
    schemas: () => [
      { name: "mcp__basic-memory__recent_activity" },
      { name: "mcp__basic-memory__list_memory_projects" },
    ],
    execute: (exec: { name: string; arguments: Record<string, unknown> }) => {
      called.push({ name: exec.name, args: exec.arguments });
      return Promise.resolve({
        isError: false,
        content: [{ type: "text", text: serverSays(exec.name) }],
      });
    },
  } satisfies NonNullable<StatusContext["tools"]>;
  const harness = fakeContext({ tools });
  registerStatusCommand(harness.ctx, { ...LABELS, project: "knowledge-base" });

  const text = await run(harness, sessionWith());

  // A bare `list_memory_projects` is not a registered name; the harness answered
  // `unknown tool "list_memory_projects"` until both names went through the lookup.
  assert.deepEqual(
    called.map((call) => call.name).sort(),
    ["mcp__basic-memory__list_memory_projects", "mcp__basic-memory__recent_activity"],
  );
  const activity = called.find((call) => call.name.endsWith("recent_activity"));
  assert.equal(activity?.args.project, "knowledge-base");
  assert.match(text, /projects:    knowledge-base, main/);
});

test("reads the payload the server wraps in result", async () => {
  const tools = {
    schemas: () => [{ name: "mcp__basic-memory__recent_activity" }],
    execute: () =>
      Promise.resolve({
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              result: [
                { title: "DSH checkpoint - wrapped", permalink: "knowledge-base/dsh/sessions/y" },
              ],
            }),
          },
        ],
      }),
  } satisfies NonNullable<StatusContext["tools"]>;
  const harness = fakeContext({ tools });
  registerStatusCommand(harness.ctx, LABELS);

  const text = await run(harness, sessionWith());

  assert.match(text, /recent:      1 newest/);
  assert.match(text, /DSH checkpoint - wrapped — knowledge-base\/dsh\/sessions\/y/);
});

test("names the reason when the tool call fails", async () => {
  const tools = {
    schemas: () => [{ name: "mcp__basic-memory__search_notes" }],
    execute: () => Promise.reject(new Error("the server is gone")),
  } satisfies NonNullable<StatusContext["tools"]>;
  const harness = fakeContext({ tools });
  registerStatusCommand(harness.ctx, LABELS);

  const text = await run(harness, sessionWith());

  // A diagnostic that only says "unavailable" leaves the reader where the failure did.
  assert.match(text, /projects:    unavailable, the server is gone/);
  assert.match(text, /recent:      unavailable, the server is gone/);
});

test("names the reason when the server answers with an error", async () => {
  const tools = {
    schemas: () => [{ name: "mcp__basic-memory__search_notes" }],
    execute: () =>
      Promise.resolve({
        isError: true,
        content: [{ type: "text", text: "project not found" }],
      }),
  } satisfies NonNullable<StatusContext["tools"]>;
  const harness = fakeContext({ tools });
  registerStatusCommand(harness.ctx, LABELS);

  const text = await run(harness, sessionWith());

  assert.match(text, /projects:    unavailable, project not found/);
});

test("says so when the session log cannot be read", async () => {
  const harness = fakeContext({ tools: makeTools() });
  registerStatusCommand(harness.ctx, LABELS);

  const text = await run(harness, {});

  assert.match(text, /plugin:      the session log could not be read/);
});
