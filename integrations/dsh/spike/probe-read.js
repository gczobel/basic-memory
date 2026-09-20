/**
 * Probe: what can a DSH plugin actually read about the conversation?
 *
 * Two questions, one run:
 *   1. Do `user/message` and `assistant/message` events carry the text, so a
 *      plugin can accumulate turns from the event stream?
 *   2. What is reachable from the session object at a step? If `session.log`
 *      is an own property, a plugin can read the raw event log directly —
 *      including events that compaction has shadowed.
 *
 * Writes a bounded structural trace: keys, shapes, and short text previews.
 * Never dumps whole payloads.
 */

import { appendFileSync } from "node:fs";

export const name = "bm-probe";

const TRACE = process.env.BM_PROBE_TRACE ?? "/tmp/bm-probe.jsonl";
const started = Date.now();

function trace(entry) {
  try {
    appendFileSync(TRACE, `${JSON.stringify({ ms: Date.now() - started, ...entry })}\n`);
  } catch {
    // A trace failure must never disturb the session under test.
  }
}

/** Bounded structural summary: keys and shapes, never full content. */
function describe(value, depth = 0) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) {
    const inner = depth < 2 && value.length > 0 ? `:${describe(value[0], depth + 1)}` : "";
    return `array[${value.length}]${inner}`;
  }
  if (typeof value === "object") return `{${Object.keys(value).join(",")}}`;
  if (typeof value === "string") return `str(${value.length})`;
  return typeof value;
}

/** Collect short text previews from anywhere inside a value. */
function texts(value, out = [], depth = 0) {
  if (depth > 6 || out.length >= 5) return out;
  if (typeof value === "string") {
    if (value.trim()) out.push(value.slice(0, 100));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) texts(item, out, depth + 1);
    return out;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) texts(value[key], out, depth + 1);
  }
  return out;
}

export function apply(ctx) {
  const counts = new Map();

  ctx.on("session/event", (session, event) => {
    const type = event?.type ?? "";
    const count = (counts.get(type) ?? 0) + 1;
    counts.set(type, count);
    if (type !== "user/message" && type !== "assistant/message") return;
    if (count > 2) return; // first two of each is enough to learn the shape
    const data = event?.data;
    trace({
      event: "message-event",
      type,
      seq: event?.seq,
      dataShape: describe(data),
      dataKeys: data && typeof data === "object" ? Object.keys(data) : typeof data,
      previews: texts(data).slice(0, 3),
    });
  });

  ctx.on(
    "agent/pre-step",
    async (event, next) => {
      const decision = await next();
      const agent = event?.agent;
      const session = agent?.session;
      if (event?.step === 1) {
        const log = session?.log;
        trace({
          event: "pre-step-reach",
          step: event?.step,
          agentKeys: agent ? Object.keys(agent) : null,
          sessionKeys: session ? Object.keys(session) : null,
          headerKeys: session?.header ? Object.keys(session.header) : null,
          logIsArray: Array.isArray(log),
          logLength: Array.isArray(log) ? log.length : null,
          logSample: Array.isArray(log) ? describe(log[log.length - 1]) : null,
          // Can the plugin see a message that compaction would shadow?
          logMessageTypes: Array.isArray(log)
            ? [...new Set(log.map((e) => e?.type))].slice(0, 12)
            : null,
        });
      }
      return decision;
    },
    { prepend: true },
  );
}
