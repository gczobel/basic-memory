/**
 * Probe: what does the plugin actually see at capture time?
 *
 * Answers three questions the end-to-end run left open: does `turn/end` fire,
 * does a human `user/message` carry `role: "user"` with `source.kind: "user"`,
 * and does an assistant message carry text where the plugin looks for it.
 */

import { appendFileSync } from "node:fs";

export const name = "bm-probe-capture";

const TRACE = process.env.BM_CAPTURE_TRACE ?? "/tmp/bm-capture.jsonl";

function trace(entry) {
  try {
    appendFileSync(TRACE, `${JSON.stringify(entry)}\n`);
  } catch {
    // A trace failure must never disturb the session under test.
  }
}

export function apply(ctx) {
  const counts = new Map();
  ctx.on("session/event", (session, event) => {
    const type = event?.type ?? "";
    const n = (counts.get(type) ?? 0) + 1;
    counts.set(type, n);
    if (type !== "user/message" && type !== "assistant/message" && type !== "turn/end") return;
    if (type === "user/message" && n > 4) return;
    const data = event?.data;
    trace({
      type,
      role: data?.role,
      sourceKind: data?.source?.kind,
      turn: data?.turn,
      contentBlocks: Array.isArray(data?.content) ? data.content.length : null,
      messageBlocks: Array.isArray(data?.message?.content) ? data.message.content.length : null,
      firstText: (() => {
        const blocks = data?.content ?? data?.message?.content;
        if (!Array.isArray(blocks)) return null;
        const text = blocks.find((b) => b?.type === "text")?.text;
        return typeof text === "string" ? text.slice(0, 60) : null;
      })(),
    });
  });
}
