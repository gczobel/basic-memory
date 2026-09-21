/**
 * Plugin configuration: two gates, and nothing else.
 *
 * Which project to read and where the server runs both belong to the host's MCP row.
 * A copy here would be a second place for the same answer to go stale.
 */

import Schema from "@deepseek-ai/schemastery";

/** A plugin row's config block as the loader hands it over, unknown keys included. */
export type PluginRowConfig = Record<string, unknown>;

/** The ambient behaviours a user can turn off from the plugin row. */
export interface BasicMemoryDshConfig {
  /** Add the orientation message at the first step of a session. */
  orientationEnabled: boolean;
  /** Ask for a checkpoint note after a compaction completes. */
  checkpointPrompt: boolean;
  /**
   * The project a mechanically written capture goes to, and what the brief reads from
   * when set.
   *
   * The one thing the plugin cannot work out for itself: the host has no idea which
   * project a session belongs to. Every sibling package names one the same way.
   */
  project?: string;
}

export const DEFAULT_CONFIG: BasicMemoryDshConfig = {
  orientationEnabled: true,
  checkpointPrompt: true,
};

export const Config = Schema.object({
  project: Schema.string().description(
    "Where a mechanically written capture goes, and what the brief reads from when set.",
  ),
  orientationEnabled: Schema.boolean()
    .default(DEFAULT_CONFIG.orientationEnabled)
    .description("Add the Basic Memory orientation message at the start of a session."),
  checkpointPrompt: Schema.boolean()
    .default(DEFAULT_CONFIG.checkpointPrompt)
    .description("Ask for a checkpoint note after a compaction completes."),
});

/** Read one gate, falling back rather than coercing: `"false"` reads as true otherwise. */
function gate(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Narrow a plugin row to the two fields the plugin reads. */
/** A project name, or `undefined` for anything that is not a non-empty string. */
function projectName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function resolveConfig(config: PluginRowConfig | undefined): BasicMemoryDshConfig {
  const project = projectName(config?.project);
  return {
    orientationEnabled: gate(config?.orientationEnabled, DEFAULT_CONFIG.orientationEnabled),
    checkpointPrompt: gate(config?.checkpointPrompt, DEFAULT_CONFIG.checkpointPrompt),
    ...(project === undefined ? {} : { project }),
  };
}
