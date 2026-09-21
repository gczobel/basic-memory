/**
 * Transport configuration and message construction.
 *
 * The Config schema is what the loader validates a plugin row against, so the
 * defaults here are the effective behaviour of a row that carries no `config`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { runBmHook } from "../src/bm.ts";
import { DEFAULT_CONFIG, resolveConfig } from "../src/config.ts";
import { createPluginMessage, deepFreeze } from "../src/messages.ts";

// --- config ---

test("a row with no config block gets the defaults", () => {
  assert.deepEqual(resolveConfig(undefined), DEFAULT_CONFIG);
});

test("a partial config keeps the defaults for what it omits", () => {
  const resolved = resolveConfig({ bmPath: "uvx" });

  assert.equal(resolved.bmPath, "uvx");
  assert.equal(resolved.briefEnabled, DEFAULT_CONFIG.briefEnabled);
  assert.equal(resolved.timeoutMs, DEFAULT_CONFIG.timeoutMs);
});

test("an empty bmCommand is treated as absent", () => {
  // `[].slice(1)` is empty, so an empty argv would spawn nothing at all.
  const resolved = resolveConfig({ bmCommand: [] });

  assert.equal(resolved.bmCommand, undefined);
});

test("a wrapper argv is preserved verbatim", () => {
  const resolved = resolveConfig({ bmCommand: ["uv", "run", "basic-memory"] });

  assert.deepEqual(resolved.bmCommand, ["uv", "run", "basic-memory"]);
});

// --- messages ---

test("a plugin message carries a snapshot source with named sections", () => {
  const message = createPluginMessage("basic-memory", "basic-memory:brief", "hello");

  assert.equal(message.role, "user");
  assert.deepEqual(message.content, [{ type: "text", text: "hello" }]);
  assert.deepEqual(message.source, {
    kind: "plugin",
    plugin: "basic-memory",
    form: "snapshot",
    sections: [{ name: "basic-memory:brief", text: "hello" }],
  });
});

test("messages are frozen so later mutation cannot rewrite history", () => {
  const message = createPluginMessage("basic-memory", "basic-memory:brief", "hello");

  assert.throws(() => {
    (message as { role: string }).role = "assistant";
  }, TypeError);
});

test("each message gets a fresh identity", () => {
  const first = createPluginMessage("basic-memory", "s", "t");
  const second = createPluginMessage("basic-memory", "s", "t");

  assert.notEqual(first.id, second.id);
});

test("deepFreeze skips AbortSignal so cancellation still works", () => {
  const controller = new AbortController();
  const value = deepFreeze({ signal: controller.signal, nested: { a: 1 } });

  assert.equal(value.signal, controller.signal);
  assert.equal(Object.isFrozen(value.nested), true);
  assert.equal(Object.isFrozen(controller.signal), false);
});

// --- CLI invocation ---

test("an unspawnable CLI resolves to undefined instead of throwing", async () => {
  const text = await runBmHook(
    { bmPath: "definitely-not-a-real-binary-xyz" },
    "session-start",
    { cwd: "/tmp" },
    { projectDir: "/tmp", timeoutMs: 5_000 },
  );

  assert.equal(text, undefined);
});

test("a non-zero exit resolves to undefined", async () => {
  const text = await runBmHook(
    { bmPath: "node", bmCommand: ["node", "-e", "process.exit(3)"] },
    "session-start",
    { cwd: "/tmp" },
    { projectDir: "/tmp", timeoutMs: 5_000 },
  );

  assert.equal(text, undefined);
});

test("stdout is returned trimmed and the hook verbs are passed through", async () => {
  const text = await runBmHook(
    { bmPath: "node", bmCommand: ["node", "-e", "process.stdout.write('  brief  ')"] },
    "pre-compact",
    { cwd: "/tmp" },
    { projectDir: "/tmp", timeoutMs: 5_000 },
  );

  assert.equal(text, "brief");
});
