/**
 * The `/bm-status` command.
 *
 * A command rather than a skill, because every fact in the report belongs to the
 * plugin: it reads the session log on each step anyway, so it can say what it injected
 * and when. Asking a model to recall that would be wrong precisely after a compaction,
 * when the injected message has been shadowed, and it is the guesswork this package
 * exists to remove.
 *
 * The harness renders a command's result in the UI and never puts it into model
 * history, so a status check costs no tokens and no turn.
 */

import { injectedSection, type MessageEvent } from "./messages.ts";
import {
  BRIEF_TIMEFRAME,
  bridgedToolName,
  callTool,
  isBasicMemoryTool,
  outcomeText,
  PROJECTS_TOOL,
  RECENT_ACTIVITY_TOOL,
  visibleToolNames,
  type ToolCall,
  type ToolRegistry,
} from "./tools.ts";

export interface CommandInvocation {
  agent?: unknown;
  signal?: AbortSignal;
}

export interface CommandResult {
  kind: "success" | "error";
  text?: string;
}

interface CommandService {
  register(definition: {
    name: string;
    description: string;
    handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
  }): () => void;
}

/** What the command needs from the plugin's own context. */
export interface StatusContext {
  tools?: ToolRegistry;
  logger?: { warn(message: string): void };
  /** Cordis service lookup, so a composition without commands still loads the plugin. */
  get?(service: string): unknown;
}

export interface StatusLabels {
  plugin: string;
  orientation: string;
  checkpoint: string;
  /** The project the plugin was configured for, so the report reads the same graph. */
  project?: string;
}

/**
 * Register the command where the host can dispatch one.
 *
 * Looked up rather than injected: a profile with no command adapter would refuse to
 * load a plugin that required the service, and a missing command is better than a
 * missing plugin.
 */
export function registerStatusCommand(ctx: StatusContext, labels: StatusLabels): void {
  const commands = ctx.get?.("commands") as CommandService | undefined;
  if (commands === undefined) {
    // Trigger: a composition with no command adapter, or a service this context cannot reach.
    // Why: silence here is how the command went missing once already, with the harness
    // rejecting an unknown slash command and showing the user nothing at all.
    // Outcome: the absence is said out loud in the harness log instead of being inferred.
    ctx.logger?.warn("basic-memory: no command service in this composition, /bm-status is not registered");
    return;
  }
  try {
    commands.register({
      name: "bm-status",
      description: "Report whether Basic Memory is wired into this session.",
      handler: (invocation) => report(ctx, labels, invocation),
    });
  } catch (error) {
    ctx.logger?.warn(`basic-memory: could not register the status command: ${String(error)}`);
  }
}

async function report(
  ctx: StatusContext,
  labels: StatusLabels,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  try {
    const tools = ctx.tools;
    const names = tools === undefined ? undefined : visibleToolNames(tools, invocation.agent);
    const bridged = names?.filter(isBasicMemoryTool) ?? [];

    const lines = [
      "Basic Memory status",
      "",
      `tools:       ${describeTools(names, bridged.length)}`,
      `plugin:      ${describeInjections(invocation.agent, labels)}`,
    ];

    if (tools === undefined) {
      lines.push("graph:       unavailable, no tool registry in this composition");
    } else if (bridged.length === 0) {
      lines.push("graph:       unavailable, no Basic Memory tool is registered");
    } else if (invocation.signal === undefined) {
      lines.push("graph:       not read, the invocation carried no cancellation signal");
    } else {
      lines.push(
        ...(await describeGraph(tools, invocation.agent, invocation.signal, labels.project)),
      );
    }
    return { kind: "success", text: lines.join("\n") };
  } catch (error) {
    return { kind: "error", text: `Basic Memory status failed: ${String(error)}` };
  }
}

function describeTools(names: string[] | undefined, bridged: number): string {
  if (names === undefined) return "the registry could not be read";
  if (bridged === 0) return "missing";
  return `present, ${bridged} registered`;
}

/** What the plugin has said in this session, read from the log rather than recalled. */
function describeInjections(agent: unknown, labels: StatusLabels): string {
  const events = eventsOf(agent);
  if (events === undefined) return "the session log could not be read";

  let orientationAt: number | undefined;
  let checkpoints = 0;
  for (const event of events) {
    const section = injectedSection(event, labels.plugin);
    if (section === labels.orientation && orientationAt === undefined) orientationAt = event.time;
    else if (section === labels.checkpoint) checkpoints += 1;
  }

  if (orientationAt === undefined && checkpoints === 0) return "nothing said yet";
  const orientation =
    orientationAt === undefined ? "no orientation" : `orientation at ${clock(orientationAt)}`;
  return `${orientation}, checkpoint requests ${checkpoints}`;
}

/**
 * The server's own answer: which projects exist, and the notes it holds newest.
 *
 * Read through `recent_activity` rather than `search_notes`, because a search payload
 * cannot cross the harness at all. Its results carry `score: -0`, and the host refuses a
 * value JSON cannot round-trip (`JSON.stringify(-0)` is `"0"`, so the sign is lost),
 * failing the whole call with `value is not lossless JSON` on every search type. Recent
 * activity answers the same question with a title and permalink per note, and validates.
 */
async function describeGraph(
  tools: ToolRegistry,
  agent: unknown,
  signal: AbortSignal,
  project: string | undefined,
): Promise<string[]> {
  const names = visibleToolNames(tools, agent) ?? [];
  const projectsTool = bridgedToolName(names, PROJECTS_TOOL) ?? PROJECTS_TOOL;
  const activityTool = bridgedToolName(names, RECENT_ACTIVITY_TOOL) ?? RECENT_ACTIVITY_TOOL;
  const projects = await callTool(tools, projectsTool, {}, signal, agent);
  // The same project the brief reads, so the report cannot describe a different graph
  // than the one the plugin actually writes to.
  const recent = await callTool(
    tools,
    activityTool,
    {
      timeframe: BRIEF_TIMEFRAME,
      page_size: 3,
      output_format: "json",
      ...(project === undefined ? {} : { project }),
    },
    signal,
    agent,
  );

  const lines = [`projects:    ${describeCall(projects, projectNames)}`];
  const found = recent.ok ? noteLines(outcomeText(recent.result)) : [];
  const recentLine = !recent.ok
    ? `unavailable, ${recent.reason}`
    : found.length === 0
      ? "none read"
      : `${found.length} newest`;
  lines.push(`recent:      ${recentLine}`);
  for (const line of found) lines.push(`             ${line}`);
  return lines;
}

/** A call's rendered value, or the reason it has none. A diagnostic says which. */
function describeCall(call: ToolCall, render: (text: string | undefined) => string): string {
  return call.ok ? render(outcomeText(call.result)) : `unavailable, ${call.reason}`;
}

/** Project names from the text `list_memory_projects` returns. */
function projectNames(text: string | undefined): string {
  if (text === undefined) return "unavailable";
  const names = text
    .split("\n")
    .map((line) => /^-\s+([^\s(]+)/.exec(line.trim())?.[1])
    .filter((name): name is string => name !== undefined);
  return names.length === 0 ? "none reported" : names.join(", ");
}

/**
 * Title and permalink lines from a JSON activity payload, or nothing when it will not parse.
 *
 * The harness hands back the text block, which is a bare array, while the server's own
 * structured content wraps the same array in `result`. Both shapes are read.
 */
function noteLines(text: string | undefined): string[] {
  if (text === undefined) return [];
  try {
    const payload: unknown = JSON.parse(text);
    const notes = Array.isArray(payload)
      ? payload
      : isRecord(payload) && Array.isArray(payload.result)
        ? payload.result
        : [];
    return notes.map(noteLine).filter((line) => line !== "");
  } catch {
    return [];
  }
}

/** `title — permalink` for one entry, or an empty line when it is not a note. */
function noteLine(value: unknown): string {
  if (!isRecord(value)) return "";
  return [value.title, value.permalink]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" — ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function eventsOf(agent: unknown): readonly MessageEvent[] | undefined {
  const session = (agent as { session?: { events?: readonly MessageEvent[] } } | undefined)?.session;
  return Array.isArray(session?.events) ? session.events : undefined;
}

function clock(time: number | undefined): string {
  if (time === undefined) return "an unknown time";
  return new Date(time).toISOString().slice(11, 19);
}
