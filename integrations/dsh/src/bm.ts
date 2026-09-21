/**
 * Invocation of the Basic Memory CLI.
 *
 * The plugin is a carrier, not a second implementation: every routing, settings,
 * query, and fencing decision lives in the released `basic-memory` package behind
 * `bm hook <verb> --harness dsh`. This module only spawns that command and reads
 * its stdout.
 *
 * Fail-open by contract. A hook must never disrupt an agent session, so every
 * failure path — a missing binary, a timeout, a non-zero exit — resolves to
 * `undefined` and the caller skips its contribution.
 */

import { spawn } from "node:child_process";

import type { BmTransport } from "./config.ts";

export interface BmCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Split the configured launcher into an executable and its argv prefix. */
export function bmCommandParts(transport: BmTransport): {
  command: string;
  argsPrefix: string[];
} {
  const command = transport.bmCommand ?? [transport.bmPath];
  return { command: command[0], argsPrefix: command.slice(1) };
}

async function runBm(
  transport: BmTransport,
  args: string[],
  options: {
    stdin?: string;
    signal?: AbortSignal;
    timeoutMs: number;
    /**
     * Detach so the child outlives this process.
     *
     * A capture is fire-and-forget: the harness does not await the observer, so
     * nothing holds the turn open, and a session that exits promptly — headless
     * mode, or a user quitting right after a turn — would otherwise kill a write
     * that is still starting up. stdout is discarded because no caller reads it;
     * stderr is kept, because a failed capture is exactly the case a developer
     * needs the reason for.
     */
    outlive?: boolean;
  },
): Promise<BmCommandResult> {
  const controller = new AbortController();
  const signals = [controller.signal, options.signal].filter(Boolean) as AbortSignal[];
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  timeout.unref?.();

  return await new Promise<BmCommandResult>((resolve, reject) => {
    const bm = bmCommandParts(transport);
    const outlive = options.outlive === true;
    const child = spawn(bm.command, [...bm.argsPrefix, ...args], {
      stdio: outlive ? ["pipe", "ignore", "pipe"] : ["pipe", "pipe", "pipe"],
      signal,
      detached: outlive,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    function finish(result: BmCommandResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    }

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    }

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    // stdin is always a pipe here; the optional access is only to satisfy the
    // narrower stdio tuple the detached path declares.
    const stdin = child.stdin;
    stdin?.on("error", (error: NodeJS.ErrnoException) => {
      stderr.push(Buffer.from(error.message));
    });
    child.on("error", fail);
    child.on("close", (code) => {
      finish({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
      });
    });
    // Release the parent's hold on the child's lifetime before the payload is
    // written, so an exit cannot cut the write short.
    if (outlive) child.unref();

    stdin?.end(options.stdin ?? "");
  });
}

/**
 * Run one `bm hook` verb and return its stdout, or `undefined` on any failure.
 *
 * `verb` is a `bm hook` subcommand (`session-start`, `pre-compact`); `payload`
 * is serialized as the hook JSON the adapter normalizes. Returns trimmed stdout
 * because the hooks render plain text: the brief for `session-start`, nothing
 * for `pre-compact`.
 *
 * Fail-open, but not silent: `warn` receives the reason once per failure. A
 * missing brief is indistinguishable from an empty graph, so a developer needs
 * the difference — an unreachable project, a broken config, a timeout — without
 * the plugin ever failing a step.
 */
export async function runBmHook(
  transport: BmTransport,
  verb: string,
  payload: Record<string, unknown>,
  options: {
    projectDir: string;
    signal?: AbortSignal;
    timeoutMs: number;
    warn?: (message: string) => void;
    /** Let the child outlive this process. For captures, which are not awaited. */
    outlive?: boolean;
  },
): Promise<string | undefined> {
  const args = ["hook", verb, "--harness", "dsh", "--project-dir", options.projectDir];
  try {
    const result = await runBm(transport, args, {
      stdin: JSON.stringify(payload),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      outlive: options.outlive,
    });
    if (result.code !== 0) {
      options.warn?.(
        `bm hook ${verb} exited ${result.code}: ${result.stderr.trim() || "(no stderr)"}`,
      );
      return undefined;
    }
    return result.stdout.trim();
  } catch (error) {
    // Trigger: the binary is missing, unlaunchable, or the timeout aborted it.
    // Why: the harness's own hook contract is fail-open, and a session must not
    // be disrupted by a memory backend that is not reachable.
    // Outcome: no context is contributed, the reason is reported, and the
    // session proceeds unchanged.
    options.warn?.(`bm hook ${verb} failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
