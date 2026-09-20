/**
 * Plugin behaviour: what reaches the model, and what happens when the CLI does
 * not.
 *
 * `bmPath: "echo"` stands in for the CLI so the real spawn path runs and its
 * stdout is what gets asserted — a stub would not prove that the argument vector
 * or the captured output is right.
 */

import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { apply, inject, name, type PluginContext, type PromptSection } from "../src/index.ts";

interface Captured {
  ctx: PluginContext;
  sections: PromptSection[];
  skills: { name: string; description: string; content: string }[];
  listeners: Map<string, ((...args: never[]) => unknown)[]>;
}

function fakeContext(): Captured {
  const sections: PromptSection[] = [];
  const skills: { name: string; description: string; content: string }[] = [];
  const listeners = new Map<string, ((...args: never[]) => unknown)[]>();
  const ctx: PluginContext = {
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
    },
    skills: {
      register(skill) {
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
  };
  return { ctx, sections, skills, listeners };
}

type StepHandler = (
  event: Record<string, unknown>,
  next: () => Promise<{ kind: string; messages?: unknown[] }>,
) => Promise<{ kind: string; messages?: unknown[] }>;

function stepHandler(captured: Captured): StepHandler {
  const handler = captured.listeners.get("agent/pre-step")?.[0];
  assert.ok(handler, "pre-step listener registered");
  return handler as unknown as StepHandler;
}

function sessionEventHandler(captured: Captured): (session: object, event: object) => void {
  const handler = captured.listeners.get("session/event")?.[0];
  assert.ok(handler, "session/event listener registered");
  return handler as unknown as (session: object, event: object) => void;
}

function makeAgent(id = "session-a", cwd = process.cwd()) {
  return { session: { header: { id, cwd } } };
}

function messageTexts(decision: { messages?: unknown[] }): string[] {
  return (decision.messages ?? []).map((message) => {
    const content = (message as { content: { text: string }[] }).content;
    return content.map((block) => block.text).join("");
  });
}

/**
 * A launcher that records something observable to a file, so a test can see what
 * the plugin actually spawned or sent. `script` runs with the hook argv appended.
 */
function recordingLauncher(script: string): { logPath: string; bmCommand: string[] } {
  const logPath = join(tmpdir(), `bm-test-${randomUUID()}.log`);
  process.env.BM_TEST_LOG = logPath;
  return { logPath, bmCommand: ["node", "-e", script] };
}

/** Wait for a fire-and-forget child to leave its mark. */
async function readEventually(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = readFileSync(path, "utf8");
      if (text.length > 0) return text;
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return "";
}

const RECORD_SPAWN = "require('fs').appendFileSync(process.env.BM_TEST_LOG,'x')";
const RECORD_STDIN = "process.stdin.on('data',d=>require('fs').appendFileSync(process.env.BM_TEST_LOG,d))";
// Records which spawn shape the capture used, then echoes stdin. With `outlive`
// the child's stdout is /dev/null (not a pipe) and it is detached; without it,
// stdout is a pipe. That difference is portable to observe and disappears if the
// capture path stops asking to outlive the session.
const RECORD_DETACH_AND_STDIN =
  "const f=require('fs');let b='';process.stdin.on('data',d=>b+=d).on('end',()=>f.appendFileSync(process.env.BM_TEST_LOG,'stdoutIsPipe='+f.fstatSync(1).isFIFO()+'\\n'+b))";
const HOLD_OPEN = "setTimeout(()=>{},1500)";

function textBlocks(text: string) {
  return [{ type: "text", text }];
}

// --- Per-turn capture ---

test("captures the conversation on a settled turn, not the injected context", async () => {
  const captured = fakeContext();
  const { logPath } = recordingLauncher(RECORD_STDIN);
  apply(captured.ctx, { bmCommand: ["node", "-e", `${RECORD_STDIN};${HOLD_OPEN}`] });
  const session = makeAgent().session;
  const emit = sessionEventHandler(captured);

  emit(session, {
    type: "user/message",
    data: { role: "user", source: { kind: "user" }, content: textBlocks("Please fix the fence.") },
  });
  // The AGENTS.md baseline, a tool result, and this plugin's own brief all arrive
  // on the same channel. None of them is the human talking.
  emit(session, {
    type: "user/message",
    data: { role: "user", source: { kind: "agent-instructions" }, content: textBlocks("baseline") },
  });
  emit(session, {
    type: "user/message",
    data: { role: "user", source: { kind: "tool" }, content: textBlocks("tool output") },
  });
  emit(session, {
    type: "user/message",
    data: { role: "user", source: { kind: "plugin" }, content: textBlocks("the brief") },
  });
  emit(session, {
    type: "assistant/message",
    data: { message: { content: textBlocks("Fence fixed.") } },
  });
  emit(session, { type: "turn/end", data: {} });

  const payload = JSON.parse(await readEventually(logPath));
  assert.equal(payload.trigger, "settled");
  assert.deepEqual(payload.turns, [
    { role: "user", text: "Please fix the fence." },
    { role: "assistant", text: "Fence fixed." },
  ]);
  rmSync(logPath, { force: true });
});

test("a later capture carries the whole session, not just the last turn", async () => {
  const captured = fakeContext();
  const { logPath } = recordingLauncher(RECORD_STDIN);
  apply(captured.ctx, { bmCommand: ["node", "-e", `${RECORD_STDIN};${HOLD_OPEN}`] });
  const session = makeAgent().session;
  const emit = sessionEventHandler(captured);

  const say = (role: "user" | "assistant", text: string) => {
    if (role === "user") {
      emit(session, {
        type: "user/message",
        data: { role: "user", source: { kind: "user" }, content: textBlocks(text) },
      });
      return;
    }
    emit(session, { type: "assistant/message", data: { message: { content: textBlocks(text) } } });
  };

  say("user", "first question");
  say("assistant", "first answer");
  emit(session, { type: "turn/end", data: {} });
  await readEventually(logPath);
  rmSync(logPath, { force: true });

  // A second turn must not overwrite the note with only its own exchange, or the
  // session's story is lost a turn at a time.
  say("user", "second question");
  say("assistant", "second answer");
  emit(session, { type: "turn/end", data: {} });

  const payload = JSON.parse(await readEventually(logPath));
  assert.deepEqual(
    payload.turns.map((turn: { text: string }) => turn.text),
    ["first question", "first answer", "second question", "second answer"],
  );
  rmSync(logPath, { force: true });
});

test("the settled capture outsources itself so it can outlive the session", async () => {
  const captured = fakeContext();
  const { logPath } = recordingLauncher(RECORD_DETACH_AND_STDIN);
  apply(captured.ctx, { bmCommand: ["node", "-e", RECORD_DETACH_AND_STDIN] });
  const session = makeAgent().session;
  const emit = sessionEventHandler(captured);

  emit(session, {
    type: "user/message",
    data: {
      role: "user",
      source: { kind: "user" },
      content: textBlocks("A substantial question about how the fence rule is chosen."),
    },
  });
  emit(session, { type: "turn/end", data: {} });

  // The harness does not await the observer, so a session that exits promptly
  // would otherwise kill a write that is still starting up. Detaching is what
  // stops that, and the stdio shape is how this test can see it.
  const log = await readEventually(logPath);
  assert.match(log, /stdoutIsPipe=false/, "the capture child runs detached");
  rmSync(logPath, { force: true });
});

test("bounds the captured conversation instead of growing without limit", async () => {
  const captured = fakeContext();
  const { logPath } = recordingLauncher(RECORD_STDIN);
  apply(captured.ctx, { bmCommand: ["node", "-e", `${RECORD_STDIN};${HOLD_OPEN}`] });
  const session = makeAgent().session;
  const emit = sessionEventHandler(captured);
  const long = "x".repeat(2_000);

  emit(session, {
    type: "user/message",
    data: { role: "user", source: { kind: "user" }, content: textBlocks(`OPENING ${long}`) },
  });
  for (let index = 0; index < 10; index += 1) {
    emit(session, {
      type: "assistant/message",
      data: { message: { content: textBlocks(`reply ${index} ${long}`) } },
    });
  }
  emit(session, { type: "turn/end", data: {} });

  const payload = JSON.parse(await readEventually(logPath));
  // The core reads the opening turn and the newest few; nothing reads the middle,
  // so sending it would only grow the payload with every turn.
  assert.match(payload.turns[0].text, /^OPENING /, "the opening turn is always kept");
  assert.ok(payload.turns.length < 12, "the middle of a long session is not sent");
  assert.ok(JSON.stringify(payload.turns).length < 9_000, "the payload stays bounded");
  rmSync(logPath, { force: true });
});

test("captures nothing before a turn ends", async () => {
  const captured = fakeContext();
  const { logPath } = recordingLauncher(RECORD_STDIN);
  apply(captured.ctx, { bmCommand: ["node", "-e", `${RECORD_STDIN};${HOLD_OPEN}`] });
  const session = makeAgent().session;

  sessionEventHandler(captured)(session, {
    type: "user/message",
    data: { role: "user", source: { kind: "user" }, content: textBlocks("mid-turn") },
  });

  assert.equal(await readEventually(logPath, 750), "");
  rmSync(logPath, { force: true });
});

test("honours captureSettled: false", async () => {
  const captured = fakeContext();
  const { logPath } = recordingLauncher(RECORD_STDIN);
  apply(captured.ctx, {
    bmCommand: ["node", "-e", `${RECORD_STDIN};${HOLD_OPEN}`],
    captureSettled: false,
  });
  const session = makeAgent().session;
  const emit = sessionEventHandler(captured);

  emit(session, {
    type: "user/message",
    data: { role: "user", source: { kind: "user" }, content: textBlocks("anything") },
  });
  emit(session, { type: "turn/end", data: {} });

  assert.equal(await readEventually(logPath, 750), "");
  rmSync(logPath, { force: true });
});

test("declares its identity and required services", () => {
  assert.equal(name, "basic-memory");
  assert.deepEqual(inject, ["systemPrompt", "skills"]);
});

test("contributes the capture reflexes as a prompt section", () => {
  const captured = fakeContext();

  apply(captured.ctx, {});

  assert.equal(captured.sections.length, 1);
  const section = captured.sections[0];
  assert.equal(section.name, "basic-memory:reflexes");
  assert.equal(section.order, 150);
  assert.match(section.text, /mcp__basic-memory__/);
});

test("registers its bundled skills as runtime skills", () => {
  const captured = fakeContext();

  apply(captured.ctx, {});

  assert.deepEqual(
    captured.skills.map((skill) => skill.name),
    ["bm-checkpoint"],
  );
  assert.ok(captured.skills[0].description.length > 0);
});

test("injects a sourced brief carrying the CLI's stdout", async () => {
  const captured = fakeContext();
  apply(captured.ctx, { bmPath: "echo" });

  const decision = await stepHandler(captured)({ agent: makeAgent(), step: 1 }, async () => ({
    kind: "enter",
    messages: [],
  }));

  assert.equal(decision.kind, "enter");
  assert.equal(decision.messages?.length, 1);
  const injected = decision.messages?.[0] as {
    role: string;
    source: { kind: string; plugin: string; form: string; sections: { name: string }[] };
  };
  assert.equal(injected.role, "user");
  assert.equal(injected.source.kind, "plugin");
  assert.equal(injected.source.plugin, "basic-memory");
  assert.equal(injected.source.form, "snapshot");
  assert.equal(injected.source.sections[0].name, "basic-memory:brief");
  // `echo` prints its argv, so this pins the hook contract actually invoked.
  assert.match(messageTexts(decision)[0], /hook session-start --harness dsh/);
});

test("briefs once per session, not once per step", async () => {
  const captured = fakeContext();
  apply(captured.ctx, { bmPath: "echo" });
  const step = stepHandler(captured);
  const agent = makeAgent();
  const next = async () => ({ kind: "enter", messages: [] });

  const first = await step({ agent, step: 1 }, next);
  const second = await step({ agent, step: 2 }, next);

  assert.equal(first.messages?.length, 1);
  assert.equal(second.messages?.length, 0);
});

test("re-briefs after a successful compaction shadows the earlier brief", async () => {
  const captured = fakeContext();
  apply(captured.ctx, { bmPath: "echo" });
  const agent = makeAgent();
  const session = agent.session;
  const next = async () => ({ kind: "enter", messages: [] });

  await stepHandler(captured)({ agent, step: 1 }, next);
  sessionEventHandler(captured)(session, { type: "compaction/summary" });
  const afterCompaction = await stepHandler(captured)({ agent, step: 3 }, next);

  assert.equal(afterCompaction.messages?.length, 1);
  assert.match(messageTexts(afterCompaction)[0], /--harness dsh/);
});

test("a failed compaction does not make the brief stale", async () => {
  const captured = fakeContext();
  apply(captured.ctx, { bmPath: "echo" });
  const agent = makeAgent();
  const next = async () => ({ kind: "enter", messages: [] });

  await stepHandler(captured)({ agent, step: 1 }, next);
  // A failed attempt closes with `compaction/end { error }` and shadows nothing.
  sessionEventHandler(captured)(agent.session, { type: "compaction/end" });
  const after = await stepHandler(captured)({ agent, step: 3 }, next);

  assert.equal(after.messages?.length, 0);
});

test("prompts for a checkpoint when the brief follows a compaction", async () => {
  const captured = fakeContext();
  // Echo stdin back, so the assertion sees the hook payload itself.
  apply(captured.ctx, { bmCommand: ["node", "-e", "process.stdin.pipe(process.stdout)"] });
  const agent = makeAgent();
  const next = async () => ({ kind: "enter", messages: [] });

  await stepHandler(captured)({ agent, step: 1 }, next);
  sessionEventHandler(captured)(agent.session, { type: "compaction/summary" });
  const after = await stepHandler(captured)({ agent, step: 3 }, next);

  // The trigger is the handshake: the core answers `compact` with the
  // post-compaction checkpoint prompt instead of the ordinary brief.
  assert.match(messageTexts(after)[0], /"trigger":"compact"/);
});

test("asks for an ordinary brief on a fresh session", async () => {
  const captured = fakeContext();
  apply(captured.ctx, { bmCommand: ["node", "-e", "process.stdin.pipe(process.stdout)"] });

  const decision = await stepHandler(captured)({ agent: makeAgent(), step: 1 }, async () => ({
    kind: "enter",
    messages: [],
  }));

  assert.match(messageTexts(decision)[0], /"trigger":"startup"/);
});

test("leaves a rejected step rejected", async () => {
  const captured = fakeContext();
  apply(captured.ctx, { bmPath: "echo" });

  const decision = await stepHandler(captured)({ agent: makeAgent(), step: 1 }, async () => ({
    kind: "reject",
  }));

  assert.deepEqual(decision, { kind: "reject" });
});

test("contributes nothing when the CLI cannot be spawned", async () => {
  const captured = fakeContext();
  apply(captured.ctx, { bmPath: "definitely-not-a-real-binary-xyz" });

  const decision = await stepHandler(captured)({ agent: makeAgent(), step: 1 }, async () => ({
    kind: "enter",
    messages: [],
  }));

  assert.equal(decision.kind, "enter");
  assert.equal(decision.messages?.length, 0);
});

test("spawns once per session when the CLI fails, not once per step", async () => {
  const captured = fakeContext();
  const { logPath, bmCommand } = recordingLauncher(RECORD_SPAWN);
  // Deliverable: the spawn count, not the absence of a message. Exit non-zero so
  // the failure path is the one under test.
  const failing = ["node", "-e", `${RECORD_SPAWN};process.exit(3)`];
  apply(captured.ctx, { bmCommand: failing });
  const agent = makeAgent();
  const next = async () => ({ kind: "enter", messages: [] });

  await stepHandler(captured)({ agent, step: 1 }, next);
  await stepHandler(captured)({ agent, step: 2 }, next);

  assert.equal(readFileSync(logPath, "utf8").length, 1, "one spawn across two steps");
  assert.ok(bmCommand.length > 0);
  rmSync(logPath, { force: true });
});

test("reports a failed spawn through the host logger", async () => {
  const warnings: string[] = [];
  const captured = fakeContext();
  captured.ctx.logger = { warn: (message) => warnings.push(message) };
  apply(captured.ctx, { bmPath: "definitely-not-a-real-binary-xyz" });

  await stepHandler(captured)({ agent: makeAgent(), step: 1 }, async () => ({
    kind: "enter",
    messages: [],
  }));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /basic-memory: bm hook session-start failed/);
});

test("reports a non-zero exit with the child's stderr", async () => {
  const warnings: string[] = [];
  const captured = fakeContext();
  captured.ctx.logger = { warn: (message) => warnings.push(message) };
  apply(captured.ctx, {
    bmCommand: ["node", "-e", "process.stderr.write('no project mapped');process.exit(2)"],
  });

  await stepHandler(captured)({ agent: makeAgent(), step: 1 }, async () => ({
    kind: "enter",
    messages: [],
  }));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /exited 2/);
  assert.match(warnings[0], /no project mapped/);
});

test("stays silent when the CLI succeeds", async () => {
  const warnings: string[] = [];
  const captured = fakeContext();
  captured.ctx.logger = { warn: (message) => warnings.push(message) };
  apply(captured.ctx, { bmPath: "echo" });

  await stepHandler(captured)({ agent: makeAgent(), step: 1 }, async () => ({
    kind: "enter",
    messages: [],
  }));

  assert.deepEqual(warnings, []);
});

test("sends the agent's model, which the session header does not carry", async () => {
  const captured = fakeContext();
  apply(captured.ctx, { bmCommand: ["node", "-e", "process.stdin.pipe(process.stdout)"] });
  const agent = {
    session: { header: { id: "session-a", cwd: process.cwd() } },
    options: { model: "deepseek-v4-flash" },
  };

  const decision = await stepHandler(captured)({ agent, step: 1 }, async () => ({
    kind: "enter",
    messages: [],
  }));

  assert.match(messageTexts(decision)[0], /"model":"deepseek-v4-flash"/);
});

test("labels a manual compaction from the event's own turn field", async () => {
  const captured = fakeContext();
  const { logPath } = recordingLauncher(RECORD_STDIN);
  apply(captured.ctx, {
    bmCommand: ["node", "-e", `${RECORD_STDIN};setTimeout(()=>{},1500)`],
  });
  const agent = makeAgent();

  // Fire-and-forget: the observer is never awaited, so wait for the child's mark.
  sessionEventHandler(captured)(agent.session, { type: "compaction/start", data: { turn: null } });

  assert.match(await readEventually(logPath), /"trigger":"manual"/);
  rmSync(logPath, { force: true });
});

test("labels a pressure compaction when the event has an open turn", async () => {
  const captured = fakeContext();
  const { logPath } = recordingLauncher(RECORD_STDIN);
  apply(captured.ctx, {
    bmCommand: ["node", "-e", `${RECORD_STDIN};setTimeout(()=>{},1500)`],
  });
  const agent = makeAgent();

  sessionEventHandler(captured)(agent.session, { type: "compaction/start", data: { turn: 3 } });

  assert.match(await readEventually(logPath), /"trigger":"pressure"/);
  rmSync(logPath, { force: true });
});

test("sends no envelope when event capture is off", async () => {
  const captured = fakeContext();
  const { logPath } = recordingLauncher(RECORD_STDIN);
  apply(captured.ctx, {
    bmCommand: ["node", "-e", `${RECORD_STDIN};setTimeout(()=>{},1500)`],
    captureEvents: false,
  });

  sessionEventHandler(captured)(makeAgent().session, {
    type: "compaction/start",
    data: { turn: 1 },
  });

  assert.equal(await readEventually(logPath, 750), "");
  rmSync(logPath, { force: true });
});

test("honours briefEnabled: false", async () => {
  const captured = fakeContext();
  apply(captured.ctx, { bmPath: "echo", briefEnabled: false });

  const decision = await stepHandler(captured)({ agent: makeAgent(), step: 1 }, async () => ({
    kind: "enter",
    messages: [],
  }));

  assert.equal(decision.messages?.length, 0);
});
