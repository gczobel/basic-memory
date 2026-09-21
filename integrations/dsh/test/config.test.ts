/** Plugin configuration: the two gates, the defaults, and old keys. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Config, DEFAULT_CONFIG, resolveConfig } from "../src/config.ts";

test("an absent config block resolves to both gates on", () => {
  assert.deepEqual(resolveConfig(undefined), {
    orientationEnabled: true,
    checkpointPrompt: true,
  });
});

test("a partial config keeps the defaults it omits", () => {
  assert.deepEqual(resolveConfig({ checkpointPrompt: false }), {
    orientationEnabled: true,
    checkpointPrompt: false,
  });
});

test("keys the plugin does not declare are dropped, not carried", () => {
  // A plugin row is a place people put things: another tool's keys, or a guess at
  // a setting this plugin does not have.
  const resolved = resolveConfig({
    // `primaryProject` is another host's spelling, which is exactly the kind of key
    // this row may carry by mistake.
    primaryProject: "knowledge-base",
    captureFolder: "dsh/sessions",
    timeoutMs: 20_000,
    orientation: true,
  });

  assert.deepEqual(resolved, DEFAULT_CONFIG);
  assert.deepEqual(Object.keys(resolved).sort(), ["checkpointPrompt", "orientationEnabled"]);
});

test("the project is read when it is a usable name, and dropped otherwise", () => {
  assert.equal(resolveConfig({ project: "knowledge-base" }).project, "knowledge-base");
  // Whitespace is not a project, and neither is a bare value of another type.
  assert.equal(resolveConfig({ project: "  " }).project, undefined);
  assert.equal(resolveConfig({ project: 7 }).project, undefined);
  assert.equal(resolveConfig(undefined).project, undefined);
});

test("a gate that is not a boolean falls back instead of being coerced", () => {
  // YAML makes `"false"` easy to write. Coercing it would read as true, and
  // ignoring it silently would read as the default without saying so.
  assert.deepEqual(resolveConfig({ orientationEnabled: "false", checkpointPrompt: 0 }), {
    orientationEnabled: true,
    checkpointPrompt: true,
  });
  assert.deepEqual(resolveConfig({ orientationEnabled: false, checkpointPrompt: false }), {
    orientationEnabled: false,
    checkpointPrompt: false,
  });
});

test("the schema declares both keys with their defaults", () => {
  assert.deepEqual(Config({}), { orientationEnabled: true, checkpointPrompt: true });
  assert.deepEqual(Config({ orientationEnabled: false }), {
    orientationEnabled: false,
    checkpointPrompt: true,
  });
});

test("the schema tolerates keys it no longer declares", () => {
  // Verified behaviour of schemastery, and the reason an old row still loads.
  const loaded = Config({ bmPath: "bm", orientationEnabled: false });

  assert.equal(loaded.orientationEnabled, false);
});
