/** Bundled skill loading: frontmatter parsing and the shipped skill. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUNDLED_SKILLS, loadBundledSkill, parseFrontmatter, skillsRoot } from "../src/skills.ts";

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

test("the shipped checkpoint skill loads with a description and body", () => {
  assert.deepEqual([...BUNDLED_SKILLS], ["bm-checkpoint"]);

  const skill = loadBundledSkill("bm-checkpoint");

  assert.ok(skill);
  assert.equal(skill.name, "bm-checkpoint");
  assert.ok(skill.description.length > 0);
  assert.match(skill.content, /write_note/);
});

test("a missing skill resolves to undefined instead of throwing", () => {
  const skill = loadBundledSkill("not-a-real-skill");

  assert.equal(skill, undefined);
});

test("skills root resolves beside the module", () => {
  const root = skillsRoot("file:///tmp/dist/index.js");

  assert.equal(root.href, "file:///tmp/skills/");
});
