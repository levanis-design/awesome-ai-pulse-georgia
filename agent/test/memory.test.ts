import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  judgedRecently,
  loadMemory,
  remember,
  saveMemory,
  type Memory,
} from "../src/memory.js";
import { daysAgo as isoDaysAgo, NOW } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "aipulse-memory-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const daysAgo = (n: number) => new Date(isoDaysAgo(n));

test("a verdict holds for 30 days, unless the repo doubles its stars", () => {
  const m: Memory = {};
  remember(
    m,
    "Acme/Tool",
    "not a fit for the collection: a game",
    10_000,
    daysAgo(5),
  );
  assert.equal(
    judgedRecently(m, "acme/tool", 12_000, NOW)?.verdict,
    "not a fit for the collection: a game",
  );
  assert.equal(judgedRecently(m, "acme/tool", 20_000, NOW), null); // grew a lot: worth a fresh look
  assert.equal(judgedRecently(m, "acme/tool", 12_000, daysAgo(-26)), null); // 31 days on
  assert.equal(judgedRecently(m, "other/repo", 1, NOW), null);
});

test("saving drops verdicts older than 30 days; a missing or garbled file reads as empty", () => {
  const m: Memory = {};
  remember(m, "old/one", "x", 1, daysAgo(40));
  remember(m, "new/one", "y", 1, daysAgo(2));
  const path = join(dir, "memory.json");
  saveMemory(path, m, NOW);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf-8"))), [
    "new/one",
  ]);
  assert.deepEqual(Object.keys(loadMemory(path)), ["new/one"]);
  assert.deepEqual(loadMemory(join(dir, "missing.json")), {});
  writeFileSync(join(dir, "bad.json"), "{oops");
  assert.deepEqual(loadMemory(join(dir, "bad.json")), {});
  assert.deepEqual(loadMemory(undefined), {});
});
