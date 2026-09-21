/**
 * Embedded runtime skills.
 *
 * DSH's `ctx.skills.register()` takes a definition rather than a directory, so
 * the plugin reads its skills from the package's own `skills/` tree and registers
 * them at load. Shipping real `SKILL.md` files keeps them reviewable as markdown
 * and editable by the user, exactly as the other integrations do, and keeps the
 * frontmatter vocabulary identical to what DSH's filesystem provider expects — so
 * a user who prefers `.dsh/skills` can copy the directory across unchanged.
 */

import { readFileSync } from "node:fs";

/** One skill ready for `ctx.skills.register()`. */
export interface EmbeddedSkill {
  name: string;
  description: string;
  content: string;
}

/** Skills shipped with this package. */
export const BUNDLED_SKILLS = ["bm-checkpoint"] as const;

/** Package-relative skills root; `dist/` and `skills/` are siblings. */
export function skillsRoot(moduleUrl: string = import.meta.url): URL {
  return new URL("../skills/", moduleUrl);
}

/**
 * Parse `name` and `description` out of a `SKILL.md` frontmatter block.
 *
 * Deliberately minimal: the two required scalar fields, single-line values only.
 * A full YAML parser would be a dependency for two keys, and a value this loader
 * cannot read is reported rather than guessed at.
 */
export function parseFrontmatter(source: string): { name?: string; description?: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { body: source };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    fields[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, "");
  }
  return { name: fields.name, description: fields.description, body: source.slice(match[0].length) };
}

/**
 * Load one bundled skill, or `undefined` when it is missing or malformed.
 *
 * Read synchronously: registration must complete during plugin load, before the
 * first `agent/pre-step` builds the skill catalog. A late registration would only
 * reach the model as a replacement catalog on a later step, and a package shipped
 * without its skills must still load — a plugin that fails at load takes the whole
 * profile down with it.
 */
export function loadBundledSkill(
  name: string,
  root: URL = skillsRoot(),
): EmbeddedSkill | undefined {
  try {
    const source = readFileSync(new URL(`${name}/SKILL.md`, root), "utf8");
    const parsed = parseFrontmatter(source);
    const description = parsed.description;
    if (!description) return undefined;
    return { name: parsed.name ?? name, description, content: parsed.body.trimStart() };
  } catch {
    return undefined;
  }
}
