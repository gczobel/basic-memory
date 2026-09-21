/** Skill loading: frontmatter parsing, one skill, and the shipped set. */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import { CHECKPOINT_SKILL, SKILL_SOURCE, loadSkill, loadSkills, parseFrontmatter, skillsRoot } from "../src/skills.ts";

test("frontmatter yields name, description, and the body", () => {
  const parsed = parseFrontmatter('---\nname: bm-x\ndescription: "Do a thing."\n---\n\n# Body\n');

  assert.equal(parsed.name, "bm-x");
  assert.equal(parsed.description, "Do a thing.");
  assert.equal(parsed.body, "\n# Body\n");
});

test("a file without frontmatter is all body", () => {
  const parsed = parseFrontmatter("# Body\n");

  assert.equal(parsed.name, undefined);
  assert.equal(parsed.description, undefined);
  assert.equal(parsed.body, "# Body\n");
});

test("unreadable frontmatter lines are skipped, not guessed", () => {
  const parsed = parseFrontmatter("---\n# a comment\nname: bm-y\nnested:\n  a: 1\n---\nbody");

  assert.equal(parsed.name, "bm-y");
  assert.equal(parsed.description, undefined);
});

test("CRLF frontmatter parses", () => {
  const parsed = parseFrontmatter("---\r\nname: bm-z\r\ndescription: Windows.\r\n---\r\nbody");

  assert.equal(parsed.name, "bm-z");
  assert.equal(parsed.description, "Windows.");
});

test("a loaded skill carries every field the harness validates", () => {
  // `ctx.skills.register()` defaults `invocation` and `provider`, then validates
  // the definition it materializes. `source` is not defaulted, and registration
  // does not check it either: a missing one registers cleanly and fails only when
  // a model loads the skill, with "source must be a string".
  const skill = loadSkill(CHECKPOINT_SKILL);

  assert.ok(skill);
  assert.equal(typeof skill.name, "string");
  assert.equal(typeof skill.description, "string");
  assert.equal(skill.source, SKILL_SOURCE);
  assert.equal(typeof skill.invocation.modelInvocable, "boolean");
  assert.equal(typeof skill.invocation.userInvocable, "boolean");
  assert.ok(skill.content.length > 0);
  // Frontmatter is the harness's contract, not the body the model reads.
  assert.doesNotMatch(skill.content, /^---/);
});

test("only the skills a session reaches for stay in the model's catalog", () => {
  const byName = new Map(loadSkills().map((skill) => [skill.name, skill.invocation]));

  for (const name of ["bm-checkpoint", "bm-decide", "memory-notes", "memory-capture", "memory-continue", "memory-tasks"]) {
    assert.deepEqual(byName.get(name), { modelInvocable: true, userInvocable: true }, name);
  }
  for (const name of ["memory-curate", "memory-onboarding", "memory-ci-capture", "memory-literary-analysis"]) {
    assert.deepEqual(byName.get(name), { modelInvocable: false, userInvocable: true }, name);
  }
  // Nothing ships invisible: a skill out of the catalog is still the user's to invoke.
  for (const [name, invocation] of byName) {
    assert.equal(invocation.userInvocable, true, name);
  }
});

test("a skill with companion files carries its base directory", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-skills-"));
  mkdirSync(join(root, "with-files", "references"), { recursive: true });
  writeFileSync(
    join(root, "with-files", "SKILL.md"),
    "---\nname: with-files\ndescription: Has references.\n---\nRead `references/deep.md`.\n",
  );
  writeFileSync(join(root, "with-files", "references", "deep.md"), "# deep\n");
  mkdirSync(join(root, "alone"));
  writeFileSync(join(root, "alone", "SKILL.md"), "---\nname: alone\ndescription: Nothing else.\n---\nbody\n");

  const skills = loadSkills(pathToFileURL(`${root}/`));

  // Without this the harness has nothing to resolve `references/deep.md` against,
  // and the skill points at a file the model cannot open.
  assert.deepEqual(skills.find((skill) => skill.name === "with-files")?.resourceBase, {
    kind: "directory",
    path: join(root, "with-files"),
  });
  assert.equal(skills.find((skill) => skill.name === "alone")?.resourceBase, undefined);
});

test("the shipped onboarding skill can resolve its references", () => {
  const skill = loadSkill("memory-onboarding");

  assert.ok(skill);
  assert.deepEqual(skill.resourceBase, {
    kind: "directory",
    path: fileURLToPath(skillsRoot()).replace(/\/$/, "") + "/memory-onboarding",
  });
  assert.match(skill.content, /references\/conventions\.md/);
});

test("the checkpoint skill writes the shared session type", () => {
  const skill = loadSkill("bm-checkpoint");

  assert.ok(skill);
  assert.match(skill.content, /`note_type`: `session`/);
  assert.match(skill.content, /`agent: dsh`/);
  assert.match(skill.content, /`capture: deliberate`/);
  // A host-private type would be invisible to every other host's brief.
  assert.doesNotMatch(skill.content, /dsh_session/);
});

test("the decide skill keeps the note shared rather than harness-scoped", () => {
  const skill = loadSkill("bm-decide");

  assert.ok(skill);
  assert.match(skill.content, /`note_type`: `decision`/);
  assert.match(skill.content, /`directory`: `decisions`/);
  // A write is where the project question belongs, so this skill asks it there.
  assert.match(skill.content, /list_memory_projects/);
  assert.match(skill.content, /ask the user when that is not clear/);
  // Another agent reads or supersedes this note, so nothing in it may name the harness.
  assert.doesNotMatch(skill.content, /dsh/);
});

test("the setup skill carries the canonical schemas it offers", () => {
  const skill = loadSkill("bm-setup");

  assert.ok(skill);
  // The model has to be able to load it: setup runs after the user agrees, in a session.
  assert.equal(skill.invocation.modelInvocable, true);
  assert.equal(skill.invocation.userInvocable, true);
  assert.match(skill.content, /references\/session\.md/);
  // Approval before writes, and never a second schema for one type.
  assert.match(skill.content, /Ask first/);
  assert.match(skill.content, /skip any\s+type that already has one/);
  // The files ride beside the skill, which is what makes the relative paths in its
  // text resolvable through the base directory the harness renders.
  assert.ok(skill.resourceBase);
  const files = readdirSync(join(skill.resourceBase.path, "references")).sort();
  assert.deepEqual(files, ["coding-session.md", "decision.md", "session.md", "task.md"]);
});

test("status is a command, not a skill", () => {
  // It reports what the plugin can prove, which a model cannot recall after a
  // compaction has shadowed the injected message.
  assert.equal(loadSkill("bm-schemas"), undefined);
  assert.equal(loadSkill("bm-status"), undefined);
});

test("a missing skill resolves to undefined instead of throwing", () => {
  assert.equal(loadSkill("not-a-real-skill"), undefined);
});

test("the package ships this plugin's checkpoint skill and the canonical set", () => {
  const names = loadSkills().map((skill) => skill.name);

  assert.ok(names.includes(CHECKPOINT_SKILL), "the plugin's own skill is packaged");
  // Copied from the monorepo by scripts/fetch-skills.ts, so these arrive with the
  // package rather than needing a separate install step on the host.
  assert.ok(names.includes("memory-notes"), "the canonical skills are packaged");
  assert.ok(names.length > 5);
  assert.deepEqual(names, [...names].sort());
});

test("the skills root lists directories, skipping anything else", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-skills-"));
  mkdirSync(join(root, "one"));
  writeFileSync(join(root, "one", "SKILL.md"), '---\nname: one\ndescription: First.\n---\nbody\n');
  mkdirSync(join(root, "two"));
  writeFileSync(join(root, "two", "SKILL.md"), '---\nname: two\ndescription: Second.\n---\nbody\n');
  // A directory with no SKILL.md, and a stray file, are both skipped.
  mkdirSync(join(root, "empty"));
  writeFileSync(join(root, "notes.md"), "not a skill\n");

  const skills = loadSkills(pathToFileURL(`${root}/`));

  assert.deepEqual(
    skills.map((skill) => skill.name),
    ["one", "two"],
  );
});

test("a skills root that cannot be read yields no skills", () => {
  assert.deepEqual(loadSkills(pathToFileURL(join(tmpdir(), "dsh-skills-absent") + "/")), []);
});

test("skills root resolves beside the module", () => {
  const root = skillsRoot("file:///tmp/dist/index.js");

  assert.equal(root.href, "file:///tmp/skills/");
});
