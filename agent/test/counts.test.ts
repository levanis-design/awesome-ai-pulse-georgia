import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { REPO_ROOT } from "../src/config.js";
import { checkCounts, CountsError, readBadgeCounts, SPOTS, updateCounts } from "../src/counts.js";

const tmp = mkdtempSync(join(tmpdir(), "aipulse-counts-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
for (const f of new Set(SPOTS.map((s) => s.file))) {
  mkdirSync(dirname(join(tmp, f)), { recursive: true });
  copyFileSync(resolve(REPO_ROOT, f), join(tmp, f));
}
const now = readBadgeCounts(readFileSync(join(tmp, "README.md"), "utf-8"));

function countIn(files: Map<string, string>, file: string, pattern: RegExp): string[] {
  return [...(files.get(file) ?? readFileSync(join(tmp, file), "utf-8")).matchAll(new RegExp(pattern.source, "g"))].map((m) => m.slice(1).join("/"));
}

test("every count spot in the real files matches the README badges today", () => {
  assert.doesNotThrow(() => checkCounts(tmp, now));
});

test("one more repo updates every spot and bumps the badge cache-buster", () => {
  const files = updateCounts(tmp, now, { repos: now.repos + 1, categories: now.categories }, { write: false });
  for (const s of SPOTS) {
    const seen = countIn(files, s.file, s.pattern);
    assert.equal(seen.length, s.expected, s.pattern.source);
    for (const v of seen) {
      const want = s.groups.map((g) => (g === "repos" ? now.repos + 1 : now.categories)).join("/");
      assert.equal(v, want, `${s.file}: ${s.pattern.source}`);
    }
  }
  const vOld = Number(/repos-\d+-00D0FF\?[^"]*?v=(\d+)/.exec(readFileSync(join(tmp, "README.md"), "utf-8"))![1]);
  const vNew = Number(/repos-\d+-00D0FF\?[^"]*?v=(\d+)/.exec(files.get("README.md")!)![1]);
  assert.equal(vNew, vOld + 1);
});

test("a README that is not written yet can be the starting point, and the disk stays as it was", () => {
  const onDisk = readFileSync(join(tmp, "README.md"), "utf-8");
  const seed = new Map([["README.md", `${onDisk}<!-- not on disk -->`]]);
  const files = updateCounts(tmp, now, { repos: now.repos - 1, categories: now.categories }, { write: false, seed });
  assert.ok(files.get("README.md")!.endsWith("<!-- not on disk -->"));
  assert.ok(files.get("README.md")!.includes(`repos-${now.repos - 1}-00D0FF`));
  assert.equal(seed.get("README.md"), `${onDisk}<!-- not on disk -->`); // the caller's map is not changed
  assert.equal(readFileSync(join(tmp, "README.md"), "utf-8"), onDisk);
});

test("a number inside another number is never hit (21 inside 212)", () => {
  const odd = { repos: 212, categories: 21 };
  updateCounts(tmp, now, odd);
  // a plain text replace of "21" → "22" would also turn 212 into 222
  const files = updateCounts(tmp, odd, { repos: 212, categories: 22 }, { write: false });
  assert.ok(files.get("docs/index.html")!.includes("212 რეპო 22 კატეგორიაში"));
  assert.ok(files.get("mcp/smithery.yaml")!.includes("Query 212 curated AI repos in 22 categories"));
  assert.ok(files.get("mcp/README.md")!.includes("(212 AI repos across 22 categories)"));
  assert.ok(files.get("README.md")!.includes("repos-212-00D0FF"));
  updateCounts(tmp, odd, now); // put the temp copy back
});

test("one drifted spot stops the run and nothing is written anywhere", () => {
  const site = join(tmp, "site/index.html");
  const original = readFileSync(site, "utf-8");
  writeFileSync(site, original.replace(`${now.repos} ხელით შერჩეული`, `${now.repos - 3} ხელით შერჩეული`));
  const readmeBefore = readFileSync(join(tmp, "README.md"), "utf-8");
  assert.throws(() => updateCounts(tmp, now, { repos: now.repos + 1, categories: now.categories }), (err: unknown) => err instanceof CountsError && /site\/index\.html: says \d+ repos/.test(err.message));
  assert.equal(readFileSync(join(tmp, "README.md"), "utf-8"), readmeBefore);
  writeFileSync(site, original);
});

test("a spot that disappeared is reported, not skipped", () => {
  const smithery = join(tmp, "mcp/smithery.yaml");
  const original = readFileSync(smithery, "utf-8");
  writeFileSync(smithery, original.replace("curated AI repos in", "hand-picked repos in"));
  assert.throws(() => checkCounts(tmp, now), /mcp\/smithery\.yaml: .* matched 0×, expected 1×/);
  writeFileSync(smithery, original);
});
