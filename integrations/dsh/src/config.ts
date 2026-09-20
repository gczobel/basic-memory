/**
 * Plugin configuration: transport and gates only.
 *
 * The knowledge-graph mapping (`project`, `captureFolder`, `checkpointOnCompact`,
 * …) deliberately does NOT live here. The plugin shells `bm hook`, and the
 * released package resolves `.dsh/basic-memory.json` itself — one resolver, in
 * one language, sharing the Python core's precedence rules. Duplicating it here
 * would let the two drift.
 *
 * So this schema carries only what the host side owns: how to reach the CLI, and
 * which ambient behaviours the user wants.
 */

import Schema from "@deepseek-ai/schemastery";

/** How to reach the Basic Memory CLI. */
export interface BmTransport {
  /** Executable to spawn. Defaults to `bm` on PATH. */
  bmPath: string;
  /** argv prefix overriding `bmPath` when the CLI needs a wrapper, e.g. `["uv", "run", "basic-memory"]`. */
  bmCommand?: string[];
}

/** Transport plus the ambient gates the user controls from the plugin row. */
export interface BasicMemoryDshConfig extends BmTransport {
  /** Inject a session brief at the first step. */
  briefEnabled: boolean;
  /** Capture the conversation to Basic Memory after each settled turn. */
  captureSettled: boolean;
  /** Record bounded lifecycle envelopes to the local inbox. */
  captureEvents: boolean;
  /** Per-invocation budget for `bm hook`; the brief is skipped when exceeded. */
  timeoutMs: number;
}

export const DEFAULT_CONFIG: BasicMemoryDshConfig = {
  bmPath: "bm",
  briefEnabled: true,
  captureSettled: true,
  captureEvents: true,
  timeoutMs: 20_000,
};

export const Config = Schema.object({
  bmPath: Schema.string()
    .default(DEFAULT_CONFIG.bmPath)
    .description("Executable to spawn for `bm hook`; defaults to `bm` on PATH."),
  bmCommand: Schema.array(Schema.string()).description(
    "argv prefix overriding `bmPath` when the CLI needs a wrapper, e.g. ['uv','run','basic-memory'].",
  ),
  briefEnabled: Schema.boolean()
    .default(DEFAULT_CONFIG.briefEnabled)
    .description("Inject a Basic Memory session brief at the first step of a session."),
  captureSettled: Schema.boolean()
    .default(DEFAULT_CONFIG.captureSettled)
    .description("Capture the conversation to Basic Memory after each settled turn."),
  captureEvents: Schema.boolean()
    .default(DEFAULT_CONFIG.captureEvents)
    .description("Record bounded lifecycle envelopes to the local Basic Memory inbox."),
  timeoutMs: Schema.number()
    .default(DEFAULT_CONFIG.timeoutMs)
    .description("Per-invocation budget for `bm hook` in milliseconds."),
});

/**
 * Apply defaults to whatever the loader handed over.
 *
 * A plugin row may carry no `config` block at all, and a partially-specified one
 * omits the rest, so every field is resolved here rather than trusted. An empty
 * `bmCommand` is treated as absent: `[].slice(1)` would otherwise spawn nothing.
 */
export function resolveConfig(config: Partial<BasicMemoryDshConfig> | undefined): BasicMemoryDshConfig {
  const merged = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  if (merged.bmCommand && merged.bmCommand.length === 0) {
    return { ...merged, bmCommand: undefined };
  }
  return merged;
}
