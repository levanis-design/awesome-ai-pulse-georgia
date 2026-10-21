import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { loadCategories, REPO_ROOT } from "../src/config.js";
import { SPOTS } from "../src/counts.js";
import { verifyTree } from "../src/verify.js";

const categories = loadCategories();

test("the repository as it stands passes the apply gate", () => {
  assert.deepEqual(verifyTree(REPO_ROOT, categories), []);
});

const tmp = mkdtempSync(join(tmpdir(), "aipulse-verify-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
for (const f of new Set([
  ...SPOTS.map((s) => s.file),
  "mcp/data/repos.json",
  "docs/data.js",
])) {
  mkdirSync(dirname(join(tmp, f)), { recursive: true });
  copyFileSync(resolve(REPO_ROOT, f), join(tmp, f));
}
const edit = (file: string, change: (s: string) => string) => {
  const path = join(tmp, file);
  const before = readFileSync(path, "utf-8");
  writeFileSync(path, change(before));
  return () => writeFileSync(path, before);
};

test("the copy starts clean, so every later failure is caused by its own edit", () => {
  assert.deepEqual(verifyTree(tmp, categories), []);
});

test("stale generated site data is named", () => {
  const undo = edit("docs/data.js", (s) =>
    s.replace(
      /"stats":\{"repos":(\d+)/,
      (_m, n: string) => `"stats":{"repos":${Number(n) - 1}`,
    ),
  );
  assert.match(
    verifyTree(tmp, categories).join("\n"),
    /docs\/data\.js says \d+\/\d+/,
  );
  undo();
});

test("a duplicated row is caught three ways: rows vs badges, the duplicate itself, and the MCP data", () => {
  const undo = edit("README.md", (s) =>
    s.replace(
      /^(\| \[.+\]\(https:\/\/github\.com\/[^)]+\) \| .+ \|)(\r?\n)/m,
      "$1$2$1$2",
    ),
  );
  const problems = verifyTree(tmp, categories).join("\n");
  assert.match(problems, /README has \d+ rows in \d+ sections, its badges say/);
  assert.match(problems, /listed twice: /);
  assert.match(problems, /mcp\/data\/repos\.json has \d+ repos/);
  undo();
});

test("a hand-written count that was not moved is named", () => {
  const undo = edit("mcp/README.md", (s) =>
    s.replace(
      /\((\d+) AI repos across/,
      (_m, n: string) => `(${Number(n) + 2} AI repos across`,
    ),
  );
  assert.match(
    verifyTree(tmp, categories).join("\n"),
    /mcp\/README\.md: says \d+ repos/,
  );
  undo();
});

test("a broken row is named with its section", () => {
  const undo = edit("README.md", (s) =>
    s.replace(
      /^(\| \[[^\]]+\]\(https:\/\/github\.com\/[^)]+\) \| )(\d+(?:\.\d)?K)( \|)/m,
      "$1lots$3",
    ),
  );
  assert.match(
    verifyTree(tmp, categories).join("\n"),
    /: stars: 'lots' is not a star cell/,
  );
  undo();
});
