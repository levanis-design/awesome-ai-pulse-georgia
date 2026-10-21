import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { loadCategories, REPO_ROOT } from "../src/config.js";
import { readBadgeCounts } from "../src/counts.js";
import {
  addRow,
  getRow,
  kfmt,
  moveRow,
  parseReadme,
  removeRow,
  renameRow,
  serializeReadme,
  starValue,
  totals,
  validateRow,
} from "../src/readme.js";
import { CATS as cats, MINI as mini } from "./helpers.js";

test("the real README survives a parse → serialize round trip byte for byte", () => {
  const text = readFileSync(resolve(REPO_ROOT, "README.md"), "utf-8");
  const doc = parseReadme(text, loadCategories());
  assert.equal(serializeReadme(doc), text);
});

test("README rows and badges agree (the invariant every apply keeps)", () => {
  const text = readFileSync(resolve(REPO_ROOT, "README.md"), "utf-8");
  const doc = parseReadme(text, loadCategories());
  assert.deepEqual(totals(doc), readBadgeCounts(text));
});

test("every real row satisfies the row contract", () => {
  const doc = parseReadme(readFileSync(resolve(REPO_ROOT, "README.md"), "utf-8"), loadCategories());
  for (const s of doc.sections) for (const r of s.rows) assert.deepEqual(validateRow(r), [], `${s.slug}: ${r.name}`);
});

test("star cells read and format the way the weekly refresh writes them", () => {
  assert.equal(starValue("195K"), 195_000);
  assert.equal(starValue("5.1K"), 5_100);
  assert.equal(starValue("934"), 934);
  assert.equal(starValue("Guide"), 0);
  assert.equal(kfmt(195_432), "195K");
  assert.equal(kfmt(5_149), "5.1K");
  assert.equal(kfmt(934), "934");
});

test("a new row lands before the first row with fewer stars, CRLF kept", () => {
  const doc = parseReadme(mini, cats);
  addRow(doc, "coding", { name: "New", url: "https://github.com/c/new", stars: "20K", desc: "ახალი აგენტი." });
  const rows = doc.sections[0]!.rows.map((r) => r.name);
  assert.deepEqual(rows, ["Big", "New", "Mid", "Small"]);
  const out = serializeReadme(doc);
  assert.ok(out.includes("| [New](https://github.com/c/new) | 20K | ახალი აგენტი. |\r\n| [Mid]"));
  assert.equal(out.split("\r\n").length, mini.split("\r\n").length + 1);
});

test("adding a listed repo or a taken display name is refused", () => {
  const doc = parseReadme(mini, cats);
  assert.throws(() => addRow(doc, "voice", { name: "Other", url: "https://github.com/A/Big", stars: "1K", desc: "x." }), /already listed/);
  assert.throws(() => addRow(doc, "voice", { name: "big", url: "https://github.com/z/z", stars: "1K", desc: "x." }), /already used/);
});

test("a row that would break the table is refused", () => {
  const doc = parseReadme(mini, cats);
  assert.throws(() => addRow(doc, "coding", { name: "P", url: "https://github.com/p/p", stars: "1K", desc: "pipe | here." }), /invalid row/);
  assert.throws(() => addRow(doc, "coding", { name: "P", url: "https://github.com/p/p", stars: "1K", desc: "no full stop" }), /invalid row/);
  assert.throws(() => addRow(doc, "nope", { name: "P", url: "https://github.com/p/p", stars: "1K", desc: "ok." }), /unknown category/);
});

test("move keeps the row and re-sorts it by stars; rename keeps place and stars", () => {
  const doc = parseReadme(mini, cats);
  moveRow(doc, "a/big", "voice");
  assert.deepEqual(doc.sections[1]!.rows.map((r) => r.name), ["Big", "Tts"]);
  renameRow(doc, "a/mid", "neworg/mid");
  assert.equal(doc.sections[0]!.rows[0]!.url, "https://github.com/neworg/mid");
  assert.equal(doc.sections[0]!.rows[0]!.stars, "12K");
  assert.equal(removeRow(doc, "a/small").name, "Small");
  assert.equal(getRow(doc, "a/small"), undefined);
  assert.deepEqual(totals(doc), { repos: 3, categories: 2 });
});

test("a README missing a category is rejected instead of half-parsed", () => {
  assert.throws(() => parseReadme(mini, [...cats, { slug: "x", emoji: "x", georgian: "არარსებული", english: "x" }]), /not found/);
});
