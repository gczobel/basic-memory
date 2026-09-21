/**
 * Plugin behaviour: what reaches the model, and when.
 *
 * The plugin keeps no state, so these tests model the log the way the harness does:
 * a step returns messages, the driver appends them as `user/message` events, and the
 * next step reads them back.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { apply, inject, name, type PluginContext, type PromptSection } from "../src/index.ts";
import { CHECKPOINT_SKILL, SKILL_SOURCE, type EmbeddedSkill } from "../src/skills.ts";

interface Captured {
  ctx: PluginContext;
  sections: PromptSection[];
  skills: EmbeddedSkill[];
  listeners: Map<string, ((...args: never[]) => unknown)[]>;
  warnings: string[];
}

/** A stand-in for the harness tool registry, recording what the plugin asked for. */
interface ToolStub {
  calls: { name: string; arguments: Record<string, unknown> }[];
  schemas(): { name: string }[];
  execute(exec: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

function fakeTools(
  options: { names?: string[]; text?: string; isError?: boolean; throw?: boolean } = {},
): ToolStub {
  const names = options.names ?? ["mcp__basic-memory__recent_activity"];
  const calls: ToolStub["calls"] = [];
  return {
    calls,
    schemas: () => names.map((name) => ({ name })),
    execute: (exec) => {
      calls.push({ name: exec.name, arguments: exec.arguments });
      if (options.throw === true) return Promise.reject(new Error("the server refused"));
      return Promise.resolve({
        isError: options.isError ?? false,
        content: [{ type: "text", text: options.text ?? "Recent Activity: three notes" }],
      });
    },
  };
}

function fakeContext(
  options: { skillsThrow?: boolean; tools?: ToolStub } = {},
): Captured {
  const sections: PromptSection[] = [];
  const skills: EmbeddedSkill[] = [];
  const warnings: string[] = [];
  const listeners = new Map<string, ((...args: never[]) => unknown)[]>();
  const ctx: PluginContext = {
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
    },
    skills: {
      register(skill) {
        if (options.skillsThrow) throw new Error("no skill service here");
        skills.push(skill);
        return () => {};
      },
    },
    on(event, handler) {
      const existing = listeners.get(event) ?? [];
      existing.push(handler);
      listeners.set(event, existing);
      return () => {};
    },
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
    // Present and answering, as it is in the harness. A test of what `apply` contributes
    // should not also be exercising a composition that has no command service, which the
    // status tests cover on purpose.
    get(service) {
      return service === "commands" ? { register: () => () => {} } : undefined;
    },
  };
  return { ctx, sections, skills, listeners, warnings };
}

/** One log entry, in the shape the plugin reads. */
interface LoggedEvent {
  type?: string;
  data?: { source?: { kind?: string; plugin?: string; sections?: { name?: string }[] } };
}

/** One session, with the log the plugin derives everything from. */
interface FakeSession {
  events: LoggedEvent[];
}

interface Decision {
  kind: string;
  messages?: readonly unknown[];
}

type StepHandler = (event: Record<string, unknown>, next: () => Promise<Decision>) => Promise<Decision>;

function makeSession(): FakeSession {
  return { events: [] };
}

/** A completed compaction, the only event that re-arms the checkpoint. */
function compact(session: FakeSession): void {
  session.events.push({ type: "compaction/summary", data: {} });
}

/** A compaction that failed, which shadows nothing and therefore asks for nothing. */
function failedCompact(session: FakeSession): void {
  session.events.push({ type: "compaction/end", data: {} });
}

/** The decision a downstream listener would hand back, plus one message of its own. */
function enter(): Promise<Decision> {
  const existing = { role: "user", content: [{ type: "text", text: "earlier context" }] };
  return Promise.resolve({ kind: "enter", messages: [existing] });
}

function stepHandler(captured: Captured): StepHandler {
  const handler = captured.listeners.get("agent/pre-step")?.[0];
  assert.ok(handler, "pre-step listener registered");
  return handler as unknown as StepHandler;
}

/** Run one step the way the driver does, logging what the listener contributed. */
async function runStep(
  captured: Captured,
  session: FakeSession,
  next: () => Promise<Decision> = enter,
): Promise<Decision> {
  const decision = await stepHandler(captured)(
    { agent: { session }, step: 0, signal: new AbortController().signal },
    next,
  );
  for (const message of decision.messages ?? []) {
    const { role, content, source } = message as {
      role?: string;
      content?: unknown;
      source?: unknown;
    };
    if (source === undefined) continue;
    session.events.push({ type: "user/message", data: { role, content, source } as never });
  }
  return decision;
}

/** Only the messages this plugin contributed, which are the ones carrying a source. */
function pluginMessages(decision: Decision): { text: string; section: string }[] {
  return (decision.messages ?? [])
    .filter((message) => (message as { source?: unknown }).source !== undefined)
    .map((message) => {
      const sourced = message as {
        content: { text: string }[];
        source: { plugin: string; sections: { name: string }[] };
      };
      return {
        text: sourced.content.map((block) => block.text).join(""),
        section: sourced.source.sections[0].name,
      };
    });
}

function messageTexts(decision: Decision): string[] {
  return (decision.messages ?? []).map((message) => {
    const content = (message as { content: { text: string }[] }).content;
    return content.map((block) => block.text).join("");
  });
}

function sectionNames(captured: Captured): string[] {
  return captured.sections.map((section) => section.name);
}

test("the plugin declares the services it needs", () => {
  assert.equal(name, "basic-memory");
  assert.deepEqual([...inject].sort(), ["skills", "systemPrompt", "tools"]);
});

test("registers a standing section that names the MCP tools", () => {
  const captured = fakeContext();
  apply(captured.ctx);

  assert.deepEqual(sectionNames(captured), ["basic-memory:reflexes"]);
  assert.match(captured.sections[0].text, /mcp__basic-memory__/);
});

test("registers every skill the package ships", () => {
  const captured = fakeContext();
  apply(captured.ctx);

  const names = captured.skills.map((skill) => skill.name);
  assert.ok(names.includes(CHECKPOINT_SKILL));
  // The canonical memory-* skills are copied into the package, so they reach the
  // model without a separate install step.
  assert.ok(names.includes("memory-notes"));
  // A skill outside the catalog is still registered, just not listed for the model.
  const curate = captured.skills.find((skill) => skill.name === "memory-curate");
  assert.equal(curate?.invocation.modelInvocable, false);
  assert.equal(curate?.invocation.userInvocable, true);
  for (const skill of captured.skills) {
    assert.ok(skill.description.length > 0);
    // Registration tolerates a missing source; loading the skill does not.
    assert.equal(skill.source, SKILL_SOURCE);
  }
});

test("orients the model at the first step of a session", async () => {
  const captured = fakeContext();
  apply(captured.ctx);
  const decision = await runStep(captured, makeSession());

  const injected = pluginMessages(decision);
  assert.equal(injected.length, 1);
  assert.equal(injected[0].section, "basic-memory:orientation");
  assert.match(injected[0].text, /recent_activity/);
  assert.match(injected[0].text, /memory:\/\//);
  // Interrogating the user at the door was the old behaviour: reading is safe wherever
  // the server points, so the project question belongs with the write.
  assert.doesNotMatch(injected[0].text, /ask the user which project/);
  assert.doesNotMatch(injected[0].text, /list_memory_projects/);
  // The step's own message stays where it was.
  assert.match(messageTexts(decision)[0], /earlier context/);
});

test("states the pinned project instead of asking about it", async () => {
  const captured = fakeContext();
  apply(captured.ctx, { project: "knowledge-base" });
  const decision = await runStep(captured, makeSession());

  const injected = pluginMessages(decision);
  // The one fact the host cannot supply, said rather than asked.
  assert.match(injected[0].text, /reads and writes the project `knowledge-base`/);
});

test("says nothing on the next step of the same session", async () => {
  const captured = fakeContext();
  apply(captured.ctx);
  const session = makeSession();

  await runStep(captured, session);
  const second = await runStep(captured, session);

  assert.equal(pluginMessages(second).length, 0);
});

test("a reload does not re-orient the session", async () => {
  const first = fakeContext();
  apply(first.ctx);
  const session = makeSession();
  await runStep(first, session);

  // A reload is a fresh plugin instance over the same session, with no memory of
  // what it said. Reading the log is what makes this a no-op.
  const reloaded = fakeContext();
  apply(reloaded.ctx);
  const decision = await runStep(reloaded, session);

  assert.equal(pluginMessages(decision).length, 0);
});

test("asks for a checkpoint once a compaction completes", async () => {
  const captured = fakeContext();
  apply(captured.ctx);
  const session = makeSession();

  await runStep(captured, session);
  compact(session);
  const decision = await runStep(captured, session);

  const injected = pluginMessages(decision);
  assert.equal(injected.length, 1);
  assert.equal(injected[0].section, "basic-memory:checkpoint");
  assert.match(injected[0].text, /bm-checkpoint/);
  assert.match(injected[0].text, /Do not write lifecycle telemetry/);
});

test("asks once per compaction, not once per step", async () => {
  const captured = fakeContext();
  apply(captured.ctx);
  const session = makeSession();

  await runStep(captured, session);
  compact(session);
  await runStep(captured, session);
  const third = await runStep(captured, session);

  assert.equal(pluginMessages(third).length, 0);
});

test("a second compaction asks again", async () => {
  const captured = fakeContext();
  apply(captured.ctx);
  const session = makeSession();

  await runStep(captured, session);
  compact(session);
  await runStep(captured, session);
  compact(session);
  const decision = await runStep(captured, session);

  const injected = pluginMessages(decision);
  assert.equal(injected.length, 1);
  assert.equal(injected[0].section, "basic-memory:checkpoint");
});

test("a request that never left the step is still owed", async () => {
  const captured = fakeContext();
  apply(captured.ctx);
  const session = makeSession();

  await runStep(captured, session);
  compact(session);

  // A rejected step contributes nothing, so nothing reaches the log and the
  // obligation survives: this is why the rule is order, not a count.
  const rejected = await runStep(captured, session, (): Promise<Decision> => {
    return Promise.resolve({ kind: "reject" });
  });
  assert.equal(pluginMessages(rejected).length, 0);

  const later = await runStep(captured, session);
  assert.deepEqual(
    pluginMessages(later).map((message) => message.section),
    ["basic-memory:checkpoint"],
  );
});

test("does not re-orient after a compaction", async () => {
  const captured = fakeContext();
  apply(captured.ctx);
  const session = makeSession();

  await runStep(captured, session);
  compact(session);
  const decision = await runStep(captured, session);

  // The standing section carries the durable half of orientation, so re-nudging
  // after every compaction would be noise.
  assert.deepEqual(
    pluginMessages(decision).map((message) => message.section),
    ["basic-memory:checkpoint"],
  );
});

test("a compaction already in a seeded log is asked about on resume", async () => {
  const captured = fakeContext();
  apply(captured.ctx);
  // A session resumed from persistence: the earlier process's orientation is in
  // the log, and so is a compaction nobody asked about, because seeded events
  // never fire on `session/event`.
  const session = makeSession();
  session.events.push({
    type: "user/message",
    data: {
      source: { kind: "plugin", plugin: name, sections: [{ name: "basic-memory:orientation" }] },
    },
  });
  compact(session);

  const decision = await runStep(captured, session);

  assert.deepEqual(
    pluginMessages(decision).map((message) => message.section),
    ["basic-memory:checkpoint"],
  );
});

test("another plugin's message is not mistaken for ours", async () => {
  const captured = fakeContext();
  apply(captured.ctx);
  const session = makeSession();
  session.events.push({
    type: "user/message",
    data: { source: { kind: "plugin", plugin: "time-context", sections: [{ name: "time" }] } },
  });

  const decision = await runStep(captured, session);

  assert.deepEqual(
    pluginMessages(decision).map((message) => message.section),
    ["basic-memory:orientation"],
  );
});

test("a failed compaction asks for nothing", async () => {
  const captured = fakeContext();
  apply(captured.ctx);
  const session = makeSession();

  await runStep(captured, session);
  failedCompact(session);
  const decision = await runStep(captured, session);

  assert.equal(pluginMessages(decision).length, 0);
});

test("orientationEnabled false withholds the orientation for good", async () => {
  const captured = fakeContext();
  apply(captured.ctx, { orientationEnabled: false });
  const session = makeSession();

  const first = await runStep(captured, session);
  const second = await runStep(captured, session);

  assert.equal(pluginMessages(first).length, 0);
  assert.equal(pluginMessages(second).length, 0);
});

test("checkpointPrompt false withholds the checkpoint request", async () => {
  const captured = fakeContext();
  apply(captured.ctx, { checkpointPrompt: false });
  const session = makeSession();

  await runStep(captured, session);
  compact(session);
  const decision = await runStep(captured, session);

  assert.equal(pluginMessages(decision).length, 0);
});

test("a rejected step is returned untouched", async () => {
  const captured = fakeContext();
  apply(captured.ctx);
  const rejected: Decision = { kind: "reject" };
  const decision = await stepHandler(captured)(
    { agent: { session: makeSession() }, step: 0 },
    () => Promise.resolve(rejected),
  );

  assert.equal(decision, rejected);
});

test("a cancelled step is returned untouched", async () => {
  const captured = fakeContext();
  apply(captured.ctx);
  const decision = await stepHandler(captured)(
    { agent: { session: makeSession() }, step: 0, signal: AbortSignal.abort() },
    enter,
  );

  assert.equal(pluginMessages(decision).length, 0);
});

test("a step with no agent is returned untouched", async () => {
  const captured = fakeContext();
  apply(captured.ctx);
  const decision = await stepHandler(captured)({ step: 0 }, enter);

  assert.equal(pluginMessages(decision).length, 0);
});

test("a session that exposes no log contributes nothing", async () => {
  const captured = fakeContext();
  apply(captured.ctx);
  const decision = await stepHandler(captured)({ agent: { session: {} } }, enter);

  assert.equal(pluginMessages(decision).length, 0);
});

test("an unexpected failure leaves the decision intact", async () => {
  const captured = fakeContext();
  apply(captured.ctx);
  const hostile: Decision = { kind: "enter" };
  Object.defineProperty(hostile, "messages", {
    get() {
      throw new Error("a decision this plugin cannot read");
    },
  });
  const decision = await stepHandler(captured)(
    { agent: { session: makeSession() }, step: 0 },
    () => Promise.resolve(hostile),
  );

  assert.equal(decision, hostile);
});

test("a gate that is not a boolean is reported once at load", () => {
  const captured = fakeContext();
  apply(captured.ctx, { orientationEnabled: "false" });

  assert.deepEqual(captured.warnings, [
    "basic-memory: orientationEnabled is not a boolean; using the default",
  ]);
  assert.deepEqual(sectionNames(captured), ["basic-memory:reflexes"]);
});

test("a skill service that refuses registration does not stop the plugin", () => {
  const captured = fakeContext({ skillsThrow: true });
  apply(captured.ctx);

  assert.equal(captured.skills.length, 0);
  assert.deepEqual(sectionNames(captured), ["basic-memory:reflexes"]);
  assert.ok(captured.warnings.length > 1);
  assert.match(captured.warnings[0], /could not register/);
});

test("attaches a brief read through the host's tools service", async () => {
  const tools = fakeTools({ text: "Recent Activity: the auth outage note" });
  const captured = fakeContext({ tools });
  apply(captured.ctx);

  const decision = await runStep(captured, makeSession());

  const [injected] = pluginMessages(decision);
  assert.equal(injected.section, "basic-memory:orientation");
  assert.match(injected.text, /recent_activity/);
  assert.match(injected.text, /the auth outage note/);
  // One call, and it asks for recent activity rather than inventing an argument set.
  assert.deepEqual(tools.calls, [{ name: "mcp__basic-memory__recent_activity", arguments: { timeframe: "7d", page_size: 10 } }]);
});

test("the brief reads from the configured project when one is named", async () => {
  const tools = fakeTools();
  const captured = fakeContext({ tools });
  apply(captured.ctx, { project: " knowledge-base " });

  await runStep(captured, makeSession());

  assert.deepEqual(tools.calls, [
    {
      name: "mcp__basic-memory__recent_activity",
      arguments: { timeframe: "7d", page_size: 10, project: "knowledge-base" },
    },
  ]);
});

test("the brief is fenced as data, longer than any fence inside it", async () => {
  const tools = fakeTools({ text: "a note ``` containing a fence" });
  const captured = fakeContext({ tools });
  apply(captured.ctx);

  const decision = await runStep(captured, makeSession());

  const [injected] = pluginMessages(decision);
  assert.match(injected.text, /data rather than instructions/);
  assert.match(injected.text, /````\n a note|````/);
  assert.match(injected.text, /containing a fence/);
});

test("a long brief is truncated", async () => {
  const tools = fakeTools({ text: "x".repeat(5_000) });
  const captured = fakeContext({ tools });
  apply(captured.ctx);

  const decision = await runStep(captured, makeSession());

  const [injected] = pluginMessages(decision);
  assert.match(injected.text, /\[brief truncated\]/);
  assert.ok(injected.text.length < 5_000);
});

test("orients without a brief when the tools service is absent", async () => {
  const captured = fakeContext();
  apply(captured.ctx);

  const decision = await runStep(captured, makeSession());

  const [injected] = pluginMessages(decision);
  assert.equal(injected.section, "basic-memory:orientation");
  assert.doesNotMatch(injected.text, /data rather than instructions/);
});

test("orients without a brief when the read fails", async () => {
  for (const tools of [
    fakeTools({ isError: true }),
    fakeTools({ throw: true }),
    fakeTools({ names: ["mcp__basic-memory__recent_activity"], text: "   " }),
  ]) {
    // The tool exists, so the session is wired; only the brief is missing.
    const captured = fakeContext({ tools });
    apply(captured.ctx);
    const decision = await runStep(captured, makeSession());
    const [injected] = pluginMessages(decision);
    assert.equal(injected.section, "basic-memory:orientation");
    assert.doesNotMatch(injected.text, /data rather than instructions/);
  }
});

test("says the server is unwired when the registry holds no Basic Memory tool", async () => {
  const tools = fakeTools({ names: ["mcp__other__search"] });
  const captured = fakeContext({ tools });
  apply(captured.ctx);

  const decision = await runStep(captured, makeSession());

  const [injected] = pluginMessages(decision);
  assert.equal(injected.section, "basic-memory:orientation");
  assert.match(injected.text, /No Basic Memory MCP server is wired/);
  assert.deepEqual(tools.calls, []);
});

test("a wired server missing one tool is not called unwired", async () => {
  // The graph is reachable, so the notice would be a false alarm about the user's
  // setup. Only the brief is unavailable.
  const tools = fakeTools({ names: ["mcp__basic-memory__search_notes"] });
  const captured = fakeContext({ tools });
  apply(captured.ctx);

  const decision = await runStep(captured, makeSession());

  const [injected] = pluginMessages(decision);
  assert.doesNotMatch(injected.text, /No Basic Memory MCP server is wired/);
  assert.doesNotMatch(injected.text, /data rather than instructions/);
});

test("stays quiet about wiring when the registry cannot be read at all", async () => {
  // No tools service means the plugin cannot tell, and guessing would be worse than
  // the plain instruction.
  const captured = fakeContext();
  apply(captured.ctx);

  const decision = await runStep(captured, makeSession());

  const [injected] = pluginMessages(decision);
  assert.doesNotMatch(injected.text, /No Basic Memory MCP server is wired/);
  assert.doesNotMatch(injected.text, /data rather than instructions/);
});

test("reads the brief once, and not when the session already has one", async () => {
  const tools = fakeTools();
  const captured = fakeContext({ tools });
  apply(captured.ctx);
  const session = makeSession();

  await runStep(captured, session);
  const second = await runStep(captured, session);

  assert.equal(tools.calls.length, 1);
  assert.equal(pluginMessages(second).length, 0);
});

test("does not read a brief when the orientation is off", async () => {
  const tools = fakeTools();
  const captured = fakeContext({ tools });
  apply(captured.ctx, { orientationEnabled: false });

  await runStep(captured, makeSession());

  assert.deepEqual(tools.calls, []);
});

test("the plugin spawns nothing and remembers nothing", () => {
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
  const files = readdirSync(srcDir).filter((entry) => entry.endsWith(".ts"));

  assert.ok(!files.includes("bm.ts"), "the CLI launcher is gone");
  for (const file of files) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /child_process|spawn\(|execFile|execSync/, `${file} spawns`);
    // Per-session state in memory is what a reload discards, so the plugin holds none.
    assert.doesNotMatch(source, /new WeakMap\(|new Map\(|new Set\(/, `${file} keeps state`);
  }
});
