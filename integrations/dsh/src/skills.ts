/**
 * Embedded runtime skills.
 *
 * `ctx.skills.register()` takes a definition rather than a directory, so the plugin
 * reads the skills out of its own `skills/` tree at load: the `memory-*` set copied
 * from the monorepo by `scripts/fetch-skills.ts`, plus `bm-checkpoint`, which is
 * written here. They stay real `SKILL.md` files, which keeps them reviewable as
 * markdown and lets a user copy the directory into `.dsh/skills` unchanged.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One skill ready for `ctx.skills.register()`. */
export interface EmbeddedSkill {
  name: string;
  description: string;
  /**
   * Where the skill came from, in the shape of the harness's own root labels
   * (`project-dsh`, `user-agents`, `bundled`).
   *
   * Required: `ctx.skills.register()` defaults `invocation` and `provider` but not
   * this, and registration does not check it either, so a missing one registers
   * cleanly and fails when a model loads the skill.
   */
  source: string;
  /** Who may load it: the model, the user typing `/name`, or both. */
  invocation: { modelInvocable: boolean; userInvocable: boolean };
  /**
   * Where the skill's own files live, when it has any.
   *
   * The harness renders this into the loaded content as a base directory, which is
   * what makes a skill's relative references resolvable. A skill whose `SKILL.md`
   * stands alone does not need it.
   */
  resourceBase?: { kind: "directory"; path: string };
  content: string;
}

/** The skill this plugin's own checkpoint flow refers to by name. */
export const CHECKPOINT_SKILL = "bm-checkpoint";

/** The source label every skill in this package carries. */
export const SKILL_SOURCE = "plugin";

/**
 * The skills a session may load on its own.
 *
 * Every skill the package ships stays user-invocable, so typing `/memory-curate`
 * still loads one that is not listed here. What this list controls is the model's
 * catalog, which carries a description for each entry and is paid once per session:
 * fifteen of them run to about 1,200 tokens, and these are the ones a session reaches
 * for while working.
 */
const MODEL_INVOCABLE: readonly string[] = [
  CHECKPOINT_SKILL,
  "bm-decide",
  "bm-setup",
  "memory-capture",
  "memory-continue",
  "memory-notes",
  "memory-tasks",
];

/** Package-relative skills root; `dist/` and `skills/` are siblings. */
export function skillsRoot(moduleUrl: string = import.meta.url): URL {
  return new URL("../skills/", moduleUrl);
}

/**
 * Parse `name` and `description` out of a `SKILL.md` frontmatter block.
 *
 * Single-line scalar values only. A YAML parser would be a dependency for two keys.
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
 * Load one skill, or `undefined` when it is missing or malformed.
 *
 * Synchronous, because registration has to finish during plugin load: a late one
 * would reach the model as a replacement catalog on a later step. A package shipped
 * without its skills still loads, since a plugin that fails at load takes the whole
 * profile down with it.
 */
export function loadSkill(name: string, root: URL = skillsRoot()): EmbeddedSkill | undefined {
  try {
    const directory = new URL(`${name}/`, root);
    const parsed = parseFrontmatter(readFileSync(new URL("SKILL.md", directory), "utf8"));
    const description = parsed.description;
    if (!description) return undefined;
    const skillName = parsed.name ?? name;
    const resourceBase = hasCompanionFiles(directory)
      ? ({ kind: "directory", path: fileURLToPath(directory).replace(/\/$/, "") } as const)
      : undefined;
    return {
      name: skillName,
      description,
      source: SKILL_SOURCE,
      invocation: {
        modelInvocable: MODEL_INVOCABLE.includes(skillName),
        userInvocable: true,
      },
      ...(resourceBase === undefined ? {} : { resourceBase }),
      content: parsed.body.trimStart(),
    };
  } catch {
    return undefined;
  }
}

/** Whether a skill ships anything besides its `SKILL.md`. */
function hasCompanionFiles(directory: URL): boolean {
  try {
    return readdirSync(fileURLToPath(directory)).some((entry) => entry !== "SKILL.md");
  } catch {
    return false;
  }
}

/** Every skill in this package, in directory order. */
export function loadSkills(root: URL = skillsRoot()): EmbeddedSkill[] {
  let names: string[];
  try {
    names = readdirSync(fileURLToPath(root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  return names
    .map((name) => loadSkill(name, root))
    .filter((skill): skill is EmbeddedSkill => skill !== undefined);
}
