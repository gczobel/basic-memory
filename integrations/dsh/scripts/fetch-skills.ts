/**
 * Copy the canonical memory-* skills into this package.
 *
 * Two sources: the monorepo's top-level `skills/` directory, whose `memory-*` skills
 * the plugin registers at load, and `integrations/shared/schemas/`, whose files ride
 * inside the `bm-setup` skill so setup offers the real schema rather than one
 * recalled from memory. Both copies are generated, gitignored, and refreshed by `prepack`.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const skillsDir = resolve(packageRoot, "skills");
const sourceDir = resolve(packageRoot, "..", "..", "skills");
const schemaSource = resolve(packageRoot, "..", "..", "integrations", "shared", "schemas");
const schemaTarget = resolve(skillsDir, "bm-setup", "references");

/** This package's own skills, written by hand and tracked in git. */
const OWN_SKILLS = ["bm-checkpoint", "bm-decide", "bm-setup"];

function canonicalSkillNames(): string[] {
  if (!existsSync(sourceDir)) {
    throw new Error(`no skills source at ${sourceDir}`);
  }
  const names = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("memory-"))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    throw new Error(`no memory-* skills in ${sourceDir}`);
  }
  return names;
}

const names = canonicalSkillNames();
console.log(`copying ${names.length} skills from ${sourceDir}`);

for (const name of names) {
  const to = resolve(skillsDir, name);
  // Clear the previous copy, so a file deleted upstream does not survive here.
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  cpSync(resolve(sourceDir, name), to, { recursive: true });

  if (!existsSync(resolve(to, "SKILL.md"))) {
    throw new Error(`${name} has no SKILL.md`);
  }
}

for (const name of OWN_SKILLS) {
  if (!existsSync(resolve(skillsDir, name, "SKILL.md"))) {
    throw new Error(`this package's own skill ${name} is missing`);
  }
}

if (!existsSync(schemaSource)) {
  throw new Error(`no schema source at ${schemaSource}`);
}
const schemaFiles = readdirSync(schemaSource).filter((entry) => entry.endsWith(".md"));
if (schemaFiles.length === 0) {
  throw new Error(`no schemas in ${schemaSource}`);
}
rmSync(schemaTarget, { recursive: true, force: true });
mkdirSync(schemaTarget, { recursive: true });
for (const file of schemaFiles) {
  cpSync(resolve(schemaSource, file), resolve(schemaTarget, file));
}

console.log(`wrote ${names.length} skills, ${schemaFiles.length} schema references, plus ${OWN_SKILLS.join(", ")}`);
