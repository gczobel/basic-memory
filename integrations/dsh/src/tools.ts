/**
 * Reading the graph through the host's tool registry.
 *
 * A bridged MCP call goes over the connection the host already owns, so nothing here
 * needs an endpoint, a transport, or any idea where the server runs.
 */

/** The registry as this package uses it: list what is visible, run one call. */
export interface ToolRegistry {
  schemas(scope?: unknown): readonly { name?: string }[];
  execute(exec: {
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
    signal: AbortSignal;
    agent?: unknown;
  }): Promise<unknown>;
}

/** What a finished call carries back. */
export interface ToolOutcome {
  isError?: boolean;
  content?: readonly { type?: string; text?: string }[];
}

/** The tool the session brief reads. */
export const RECENT_ACTIVITY_TOOL = "recent_activity";

/** The tool the status command reads. */
export const SEARCH_TOOL = "search_notes";

/** The tool that names the projects the server holds. */
export const PROJECTS_TOOL = "list_memory_projects";

/**
 * Tools whose presence means a Basic Memory server is wired.
 *
 * More than one, because the question is whether a server is reachable at all, and a
 * deployment missing a single tool is still wired.
 */
const ANCHOR_TOOLS = [RECENT_ACTIVITY_TOOL, SEARCH_TOOL, "write_note"] as const;

/** How far back the brief looks. */
export const BRIEF_TIMEFRAME = "7d";

/** The names the registry holds for this agent, or `undefined` when it cannot say. */
export function visibleToolNames(tools: ToolRegistry, agent: unknown): string[] | undefined {
  try {
    return tools
      .schemas(agent as never)
      .map((schema) => schema.name)
      .filter((toolName): toolName is string => typeof toolName === "string");
  } catch {
    return undefined;
  }
}

/**
 * The registered name of one tool, from a name list.
 *
 * A bridged server registers `mcp__<serverName>__<tool>`, and the server name belongs
 * to the host's MCP row, so the name is looked up rather than assumed.
 */
export function bridgedToolName(names: readonly string[], tool: string): string | undefined {
  return names.find((name) => name === tool) ?? names.find((name) => name.endsWith(`__${tool}`));
}

/** Whether a registered name is a bridged Basic Memory tool. */
export function isBasicMemoryTool(toolName: string): boolean {
  return ANCHOR_TOOLS.some((anchor) => toolName === anchor || toolName.endsWith(`__${anchor}`));
}

/**
 * The outcome of one call: the result, or the reason there is none.
 *
 * Both are returned rather than thrown, because the two callers want opposite things
 * from a failure. The session brief treats it as "no brief this time" and says nothing;
 * the status command exists to name what is broken, so a reason it cannot see is a
 * reason it cannot report.
 */
export type ToolCall =
  | { ok: true; result: ToolOutcome }
  | { ok: false; reason: string };

/** Run one tool call, reporting a failure as a value instead of throwing. */
export async function callTool(
  tools: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  agent: unknown,
): Promise<ToolCall> {
  try {
    const result = (await tools.execute({
      callId: globalThis.crypto.randomUUID(),
      name,
      arguments: args,
      signal,
      agent,
    })) as ToolOutcome | undefined;
    if (result === undefined) return { ok: false, reason: "the registry returned nothing" };
    if (result.isError === true) {
      return { ok: false, reason: outcomeText(result) ?? "the server reported an error" };
    }
    return { ok: true, result };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The text of a finished call, or `undefined` when it carried none. */
export function outcomeText(result: ToolOutcome | undefined): string | undefined {
  const text = (result?.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block?.text ?? "")
    .join("\n")
    .trim();
  return text === "" ? undefined : text;
}
