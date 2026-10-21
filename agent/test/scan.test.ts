import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadRules } from "../src/config.js";
import type { RepoFacts } from "../src/facts.js";
import { GitHub } from "../src/github.js";
import { ISSUE_BODY_MAX, issueBody } from "../src/proposals.js";
import { parseReadme } from "../src/readme.js";
import { staleNote } from "../src/rules.js";
import { englishProposal, healthProposals, type Ctx } from "../src/scan.js";
import { CATS, facts, miniReadme, NOW } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "aipulse-scan-"));
after(() => rmSync(root, { recursive: true, force: true }));
const ctx: Ctx = { gh: new GitHub(undefined), rules: loadRules(), categories: CATS, root, llm: { apiKey: undefined, model: "m" }, now: NOW };

const doc = parseReadme(
  miniReadme(
    [
      "| [Gone](https://github.com/a/gone) | 50K | წაშლილი. |",
      "| [Frozen](https://github.com/a/frozen) | 40K | დაარქივებული. |",
      "| [Moved](https://github.com/a/moved) | 30K | გადატანილი. |",
      "| [Sunk](https://github.com/a/sunk) | 3.1K | დაცემული. |",
      "| [Hover](https://github.com/a/hover) | 3K | ზღვარზე. |",
      "| [Sentry](https://github.com/getsentry/sentry-mcp) | 934 | ოფიციალური. |",
      "| [Guide](https://github.com/a/guide/blob/main/x.md) | Guide | გზამკვლევი. |",
    ],
    [
      "| [Quiet](https://github.com/b/quiet) | 20K | ჩუმი. |",
      "| [Noted](https://github.com/b/noted) | 10K | შენიშვნით. შენიშვნა: 2024 წლის მაისის შემდეგ აღარ განახლებულა. |",
      "| [Unknown](https://github.com/b/unknown) | 9K | უცნობი. |",
    ],
  ),
  CATS,
);

test("health: gone, archived, moved, sunk under the floor and gone quiet each become one proposal", () => {
  const live = new Map<string, RepoFacts | null>([
    ["a/gone", null],
    ["a/frozen", facts("a/frozen", { isArchived: true, pushedAt: "2025-02-03T00:00:00Z" })],
    ["a/moved", facts("neworg/moved")],
    // under the floor AND renamed AND stale: leaving the list is the only proposal
    ["a/sunk", facts("a/sunk-renamed", { stars: 2_600, pushedAt: "2024-01-01T00:00:00Z" })],
    ["a/hover", facts("a/hover", { stars: 2_800 })],
    ["getsentry/sentry-mcp", facts("getsentry/sentry-mcp", { stars: 950 })],
    ["b/quiet", facts("b/quiet", { pushedAt: "2025-03-09T00:00:00Z" })],
    ["b/noted", facts("b/noted", { pushedAt: "2024-05-01T00:00:00Z" })],
  ]);
  assert.deepEqual(healthProposals(ctx, doc, live), [
    { type: "remove", repo: "a/gone", reason: "deleted", detail: "GitHub ამ მისამართზე რეპოს ვეღარ პოულობს" },
    { type: "remove", repo: "a/frozen", reason: "archived", detail: "ბოლო ცვლილება 2025-02-03" },
    { type: "rename", from: "a/moved", to: "neworg/moved" },
    { type: "remove", repo: "a/sunk", reason: "below-floor", detail: "ახლა 2,600 ვარსკვლავი აქვს, ზღვარი 3,000-ია" },
    { type: "note", repo: "b/quiet", note: staleNote("2025-03-09T00:00:00Z") },
  ]);
});

test("English descriptions follow GitHub, but hand-written ones for empty GitHub text stay", () => {
  mkdirSync(join(root, "mcp", "data"), { recursive: true });
  writeFileSync(
    join(root, "mcp", "data", "github-cache.json"),
    JSON.stringify({
      "a/moved": { description: "Old text", fetchedAt: "2026-01-01T00:00:00Z" },
      "a/hover": { description: "Same text", fetchedAt: "2026-01-01T00:00:00Z" },
      "a/sunk": { description: "Hand-written, GitHub has none", fetchedAt: "2026-01-01T00:00:00Z" },
    }),
  );
  const live = new Map<string, RepoFacts | null>([
    ["a/gone", null],
    ["a/frozen", facts("a/frozen", { description: "x".repeat(401) })],
    ["a/moved", facts("a/moved", { description: "New text" })],
    ["a/sunk", facts("a/sunk", { description: null })],
    ["a/hover", facts("a/hover", { description: "Same text" })],
    ["getsentry/sentry-mcp", facts("getsentry/sentry-mcp", { description: "   " })],
    ["b/quiet", facts("b/quiet", { description: "  Quiet text  " })],
  ]);
  assert.deepEqual(englishProposal(ctx, doc, live), {
    type: "english",
    updates: [
      { repo: "a/moved", description: "New text" },
      { repo: "b/quiet", description: "Quiet text" },
    ],
  });
});

test("a big English batch is cut to what one GitHub issue can hold", () => {
  const rows = Array.from({ length: 300 }, (_, i) => `| [R${i}](https://github.com/o/r${i}) | 5K | აღწერა ${i}. |`);
  const big = parseReadme(miniReadme(rows, ["| [Tts](https://github.com/b/tts) | 30K | ხმის მოდელი. |"]), CATS);
  const live = new Map<string, RepoFacts | null>(rows.map((_, i) => [`o/r${i}`, facts(`o/r${i}`, { description: `${"word ".repeat(79)}end.`.slice(0, 400) })]));
  const p = englishProposal({ ...ctx, root: join(root, "nowhere") }, big, live);
  if (!p || p.type !== "english") throw new Error("expected an english proposal");
  assert.ok(p.updates.length > 100 && p.updates.length < 300, `kept ${p.updates.length}`);
  assert.ok(issueBody(p, CATS).length <= ISSUE_BODY_MAX);
  assert.equal(p.updates[0]!.repo, "o/r0"); // the rest waits for the next scan, in order
});
