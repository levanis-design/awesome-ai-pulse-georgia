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
  assert.equal(starValue("1.2M"), 1_200_000);
  assert.equal(starValue("934"), 934);
  assert.equal(starValue("Guide"), 0);
  // the refresh's own cases (fmtStars in mcp/scripts/refresh-stars.ts), including where rounding differs from toFixed
  const cases: Array<[number, string]> = [[934, "934"], [1_000, "1.0K"], [1_150, "1.2K"], [5_149, "5.1K"], [9_960, "10.0K"], [10_499, "10K"], [195_432, "195K"], [999_499, "999K"], [1_000_000, "1.0M"], [1_250_000, "1.3M"]];
  for (const [n, cell] of cases) assert.equal(kfmt(n), cell, String(n));
  assert.deepEqual(validateRow({ name: "Huge", url: "https://github.com/a/huge", stars: kfmt(1_000_000), desc: "ძალიან დიდი." }), []);
});

test("a table with no rows, also one at the very end of the file, keeps its lines and takes new rows", () => {
  const empty = parseReadme(mini, cats);
  removeRow(empty, "b/tts");
  const text = serializeReadme(empty);
  const again = parseReadme(text, cats);
  assert.deepEqual(again.sections[1]!.rows, []);
  assert.equal(serializeReadme(again), text);
  addRow(again, "voice", { name: "Back", url: "https://github.com/b/back", stars: "1K", desc: "დაბრუნდა." });
  assert.equal(serializeReadme(again), text.replace(`|---|---|---|\r\n\r\n## ჩვენს`, `|---|---|---|\r\n| [Back](https://github.com/b/back) | 1K | დაბრუნდა. |\r\n\r\n## ჩვენს`));

  const atEnd = text.slice(0, text.lastIndexOf("|---|---|---|") + "|---|---|---|".length);
  const last = parseReadme(atEnd, cats);
  assert.equal(serializeReadme(last), atEnd);
  addRow(last, "voice", { name: "Tail", url: "https://github.com/b/tail", stars: "2K", desc: "ბოლოში." });
  assert.equal(serializeReadme(last), `${atEnd}\r\n| [Tail](https://github.com/b/tail) | 2K | ბოლოში. |`);
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

test("rename keeps place, name and stars; remove takes the row out", () => {
  const doc = parseReadme(mini, cats);
  renameRow(doc, "a/mid", "neworg/mid");
  assert.deepEqual(doc.sections[0]!.rows[1], { name: "Mid", url: "https://github.com/neworg/mid", stars: "12K", desc: "საშუალო აგენტი." });
  assert.throws(() => renameRow(doc, "a/big", "neworg/mid"), /already listed/);
  assert.equal(removeRow(doc, "a/small").name, "Small");
  assert.equal(getRow(doc, "a/small"), undefined);
  assert.deepEqual(totals(doc), { repos: 3, categories: 2 });
});

test("a README missing a category is rejected instead of half-parsed", () => {
  assert.throws(() => parseReadme(mini, [...cats, { slug: "x", emoji: "x", georgian: "არარსებული", english: "x" }]), /not found/);
});
