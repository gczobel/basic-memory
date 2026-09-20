/**
 * Message construction for DSH injection.
 *
 * The shapes are declared structurally rather than imported from
 * `@deepseek-ai/dsh-llm`, so the plugin carries no runtime dependency on the
 * harness packages. DSH's own `dsh-repeat-tool-reminder` inlines the same
 * helpers for the same reason, and `MessageId` is a pure branded-string
 * passthrough at runtime.
 */

/** One model-facing content block. Only text is produced here. */
export interface TextBlock {
  readonly type: "text";
  readonly text: string;
}

/** Producer-declared context: a named contribution to a snapshot. */
export interface SnapshotSection {
  readonly name: string;
  readonly text: string;
}

/**
 * Where injected content came from. `kind` answers *who produced this*; `form`
 * answers *what kind of thing it is* — the brief is a snapshot, so it carries
 * named sections and a later snapshot from the same producer supersedes it.
 */
export interface PluginMessageSource {
  readonly kind: "plugin";
  readonly plugin: string;
  readonly form: "snapshot";
  readonly sections: readonly SnapshotSection[];
}

export interface UserMessage {
  readonly id: string;
  readonly role: "user";
  readonly content: readonly TextBlock[];
  readonly source: PluginMessageSource;
}

/**
 * Deep-freeze a value in place, guarding cycles.
 *
 * {@link AbortSignal} is skipped deliberately: it is the request's live
 * cancellation channel, and freezing it breaks abort.
 */
export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof AbortSignal || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  return value;
}

/** Build one frozen user message carrying plugin-sourced context. */
export function createPluginMessage(
  plugin: string,
  sectionName: string,
  text: string,
): UserMessage {
  return deepFreeze({
    id: globalThis.crypto.randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: {
      kind: "plugin",
      plugin,
      form: "snapshot",
      sections: [{ name: sectionName, text }],
    },
  });
}
