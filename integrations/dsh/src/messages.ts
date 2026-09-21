/**
 * Message construction for DSH injection.
 *
 * Declared structurally rather than imported from `@deepseek-ai/dsh-llm`, so the
 * plugin carries no runtime dependency on the harness packages.
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
 * Where injected content came from: `kind` says who produced it, `form` says what
 * kind of thing it is. An injected message is a snapshot, so a later one from the
 * same producer supersedes it.
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
 * `AbortSignal` is skipped: it is the request's live cancellation channel, and
 * freezing it breaks abort.
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

/**
 * A session event, as far as message identity is concerned.
 *
 * The log's own shape is larger; this is the part that says whether an event is a
 * message this plugin contributed, and when it arrived.
 */
export interface MessageEvent {
  type?: string;
  time?: number;
  data?: { source?: { kind?: string; plugin?: string; sections?: readonly { name?: string }[] } };
}

/**
 * The section a message carried, or `undefined` for anything else.
 *
 * A plugin recovers its own history from the log by reading the attribution it stamped
 * on each message: `source.plugin` says who produced it, and the section name says
 * which of that plugin's messages it is.
 */
export function injectedSection(event: MessageEvent | undefined, plugin: string): string | undefined {
  if (event?.type !== "user/message") return undefined;
  const source = event.data?.source;
  if (source?.kind !== "plugin" || source.plugin !== plugin) return undefined;
  return source.sections?.[0]?.name;
}
