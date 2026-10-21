import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { reportApply, runApply } from "../src/apply.js";
import { loadCategories, REPO_ROOT } from "../src/config.js";
import { checkCounts, readBadgeCounts, SPOTS } from "../src/counts.js";
import type { RepoFacts } from "../src/facts.js";
import type { GitHub } from "../src/github.js";
import { issueBody, LABELS, type Proposal } from "../src/proposals.js";
import { getRow, parseReadme, pathOf, serializeReadme, starValue } from "../src/readme.js";
import { hasStaleNote, isVendor } from "../src/rules.js";
import type { Ctx } from "../src/scan.js";
import { DESC_OK, facts, fakeGraphql, fakeTracker, issue, NOW, RULES } from "./helpers.js";

/** A throwaway copy of every file apply may touch. */
function copyTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "aipulse-apply-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  for (const f of new Set([...SPOTS.map((s) => s.file), "mcp/data/github-cache.json"])) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    copyFileSync(resolve(REPO_ROOT, f), join(dir, f));
  }
  return dir;
}

const tmp = copyTree();
const categories = loadCategories();
const rules = RULES;
const readme = (root = tmp) => readFileSync(join(root, "README.md"), "utf-8");
const original = readme();
const start = parseReadme(original, categories);

// real rows to act on: independent projects (vendors never sink under the floor) without a stale note
const repoRows = (slug: string) =>
  start.sections.find((s) => s.slug === slug)!.rows.filter((r) => /^[\w.-]+\/[\w.-]+$/.test(pathOf(r.url)) && !isVendor(pathOf(r.url), rules) && !hasStaleNote(r.desc));
const removePath = pathOf(repoRows("voice").at(-1)!.url);
const [renameRow, englishRow, aliasRow, busyRow, quietRow] = repoRows("coding");
const renamePath = pathOf(renameRow!.url);
const renamedTo = `renamed-org/${renamePath.split("/")[1]}`;
const englishPath = pathOf(englishRow!.url);
const aliasPath = pathOf(aliasRow!.url);
const aliasTarget = `moved-org/${aliasPath.split("/")[1]!.toLowerCase()}`;
const busyPath = pathOf(busyRow!.url);
const quietPath = pathOf(quietRow!.url);
// what staleNote() derives from the last push the fake GitHub reports for the renamed repo
const note = "შენიშვნა: 2025 წლის მაისის შემდეგ აღარ განახლებულა.";
const quietSince = "2025-05-14T09:00:00Z";

const owner = rules.repo.split("/")[0]!;
const approved: string[] = [LABELS.proposal, LABELS.approved];
const filed = (n: number, p: Proposal, author = "github-actions[bot]", labels = approved) => issue(n, { body: issueBody(p, categories), labels, user: { login: author } });
const add = (repo: string, name: string, category: string): Proposal => ({ type: "add", repo, name, category, description: DESC_OK, stars: 1, why: "x", warnings: [], evidence: {} });

const tracker = fakeTracker(
  rules.repo,
  [
    filed(11, add("acme/voice-kit", "Voice Kit Test", "voice")),
    filed(12, add("acme/agent-kit", "Agent Kit Test", "coding"), owner),
    filed(13, { type: "remove", repo: removePath, reason: "below-floor", detail: "x" }),
    filed(14, { type: "rename", from: renamePath, to: renamedTo }),
    filed(15, { type: "note", repo: renamePath, note }), // still names the old path
    filed(16, {
      type: "english",
      updates: [
        { repo: englishPath, description: "Fresh English text" },
        { repo: aliasPath, description: "Words GitHub never wrote" }, // not what GitHub says today
      ],
    }),
    filed(17, add("evil/repo", "Evil", "coding"), "mallory"),
    filed(18, { type: "describe", repo: englishPath, old: "stale text", new: DESC_OK, why: "x" }),
    filed(19, add("Wei-Shaw/sub2api", "Pool", "tokens")),
    issue(20, { body: "please add something", labels: approved, user: { login: owner } }),
    filed(21, add(aliasTarget, "Alias Test", "coding")), // GitHub moved a listed repo here
    filed(22, add("acme/by-mallory", "Picked By Mallory", "coding")),
    filed(23, add("acme/no-event", "No Event", "coding")),
    filed(24, add("acme/turned-down", "Turned Down", "coding"), "github-actions[bot]", [...approved, LABELS.rejected]),
    filed(25, add("acme/a-fork", "A Fork", "coding")),
    filed(26, add("acme/farmed", "Farmed", "coding")),
    filed(27, add("acme/sunk", "Sunk", "coding")),
    filed(28, add("acme/edited", "Edited", "coding")), // edited after it was filed
    // the summary the owner read names another repo than the data underneath
    issue(29, { body: issueBody(add("acme/swapped", "Swapped", "coding"), categories).replace("https://github.com/acme/swapped · ⭐", "https://github.com/acme/innocent · ⭐"), labels: approved }),
    filed(30, { type: "remove", repo: englishPath, reason: "archived", detail: "x" }), // GitHub says it is not archived
    filed(31, { type: "note", repo: busyPath, note }), // pushed to this month
    filed(32, add("acme/unanswered", "Unanswered", "coding")), // GitHub does not say whether it was edited
    // quiet indeed, but the note is free text instead of the one its last push gives
    filed(33, { type: "note", repo: quietPath, note: "შენიშვნა: აღარ ახლდება, ნახე evil.example." }),
    filed(34, { type: "english", updates: [{ repo: aliasPath, description: "Words GitHub never wrote" }] }), // nothing left to write
  ],
  { approvedBy: { 22: "mallory", 23: null } },
);

const live = new Map<string, RepoFacts>([
  ["acme/voice-kit", facts("acme/voice-kit", { stars: 15_000 })],
  ["acme/agent-kit", facts("acme/agent-kit", { stars: 7_500 })],
  ["wei-shaw/sub2api", facts("Wei-Shaw/sub2api")],
  [renamePath.toLowerCase(), facts(renamedTo, { pushedAt: quietSince })],
  [renamedTo.toLowerCase(), facts(renamedTo, { pushedAt: quietSince })],
  [removePath.toLowerCase(), facts(removePath, { stars: 2_000 })],
  [englishPath.toLowerCase(), facts(englishPath, { description: "  Fresh English text " })],
  [busyPath.toLowerCase(), facts(busyPath)],
  [quietPath.toLowerCase(), facts(quietPath, { pushedAt: quietSince })],
  [aliasPath.toLowerCase(), facts(aliasTarget)],
  [aliasTarget, facts(aliasTarget)],
  ["acme/by-mallory", facts("acme/by-mallory")],
  ["acme/no-event", facts("acme/no-event")],
  ["acme/turned-down", facts("acme/turned-down")],
  ["acme/a-fork", facts("acme/a-fork", { isFork: true })],
  ["acme/farmed", facts("acme/farmed", { stars: 9_000, forks: 10 })],
  ["acme/sunk", facts("acme/sunk", { stars: 2_500, forks: 300 })],
]);
const gh = { rest: tracker.client.rest, graphqlPartial: fakeGraphql(live, { edited: { 28: "2026-10-15T10:00:00Z" }, unanswered: [32] }) } as unknown as GitHub;
const ctx: Ctx = { gh, rules, categories, root: tmp, llm: { apiKey: undefined, model: "m" }, now: NOW };

const APPLIED = [14, 13, 15, 11, 12, 16];

test("a dry run reports the same outcome and writes nothing", async () => {
  const r = await runApply(ctx, { dryRun: true });
  assert.deepEqual(r.applied.map((a) => a.number), APPLIED);
  assert.deepEqual(r.changedFiles, []);
  assert.equal(r.error, undefined);
  assert.equal(readme(), original);
});

test("approved proposals land in a fixed order; untrusted, edited, stale and excluded ones fail with a reason", async () => {
  const r = await runApply(ctx, { dryRun: false });
  assert.deepEqual(r.applied.map((a) => a.number), APPLIED);
  const why = Object.fromEntries(r.failed.map((f) => [f.number, f.error]));
  assert.match(why[17] ?? "", /filed by mallory/);
  assert.match(why[18] ?? "", /description changed/);
  assert.match(why[19] ?? "", /exclusion list/);
  assert.match(why[20] ?? "", /no readable proposal/);
  assert.equal(why[21], `already listed as ${aliasPath}`);
  assert.match(why[22] ?? "", /approved by mallory, not by the owner/); // only the owner's own label counts
  assert.match(why[23] ?? "", /approved by nobody/);
  assert.match(why[24] ?? "", /also carries agent:rejected/);
  assert.equal(why[25], "a fork"); // the scan's gates again, on the day's numbers
  assert.match(why[26] ?? "", /star-farming signs/);
  assert.match(why[27] ?? "", /2500 stars, under the 3000 floor/);
  // what runs is exactly what the owner read: never an edited issue, never a summary that differs
  assert.match(why[28] ?? "", /edited on 2026-10-15, and an edited proposal is never applied/);
  assert.match(why[29] ?? "", /not what the agent files for this proposal/);
  assert.match(why[32] ?? "", /whether the issue was edited could not be read/);
  // a removal or a note is checked again on today's facts
  assert.match(why[30] ?? "", /the reason \(archived\) no longer holds today/);
  assert.match(why[31] ?? "", /not quiet any more/);
  assert.match(why[33] ?? "", /the note is not the one the repo's last push gives/);
  assert.match(why[34] ?? "", /GitHub says something else today for every one of these/);
  assert.equal(r.failed.length, 18);
  assert.match(r.applied.find((a) => a.number === 16)?.summary ?? "", /^1 ინგლისური აღწერა განახლდა; 1 გამოტოვდა/);
  assert.deepEqual(r.counts.after, { repos: r.counts.before.repos + 1, categories: r.counts.before.categories });

  const text = readme();
  const doc = parseReadme(text, categories);
  assert.equal(serializeReadme(doc), text);
  assert.equal(getRow(doc, removePath), undefined);
  assert.equal(getRow(doc, "acme/voice-kit")?.stars, "15K"); // fresh stars at apply time, not the proposal's
  assert.equal(getRow(doc, "acme/agent-kit")?.stars, "7.5K");
  const voice = doc.sections.find((s) => s.slug === "voice")!.rows;
  const at = voice.findIndex((x) => x.name === "Voice Kit Test");
  assert.ok(at >= 0);
  assert.ok(voice.slice(0, at).every((x) => starValue(x.stars) >= 15_000), "every row above has at least as many stars");
  assert.ok(at === voice.length - 1 || starValue(voice[at + 1]!.stars) < 15_000, "the row below has fewer");
  assert.equal(getRow(doc, renamePath), undefined);
  assert.ok(getRow(doc, renamedTo)?.desc.endsWith(` ${note}`), "the note follows the rename made in the same run");

  const after = readBadgeCounts(text);
  assert.deepEqual(after, r.counts.after);
  assert.doesNotThrow(() => checkCounts(tmp, after)); // every count spot moved with it
  const cache = JSON.parse(readFileSync(join(tmp, "mcp/data/github-cache.json"), "utf-8")) as Record<string, { description: string; fetchedAt: string }>;
  const cacheBefore = JSON.parse(readFileSync(resolve(REPO_ROOT, "mcp/data/github-cache.json"), "utf-8")) as typeof cache;
  assert.deepEqual(cache[englishPath], { description: "Fresh English text", fetchedAt: NOW.toISOString() });
  assert.deepEqual(cache[aliasPath], cacheBefore[aliasPath]); // only GitHub's own words get in
  for (const f of ["README.md", "docs/index.html", "mcp/smithery.yaml", "mcp/data/github-cache.json"]) assert.ok(r.changedFiles.includes(f), f);

  await reportApply(ctx, r, { changeUrl: "https://github.com/owner/repo/commit/abc1234" });
  assert.deepEqual(tracker.labelsOf(11).sort(), [LABELS.applied, LABELS.proposal].sort());
  assert.equal(tracker.issues.get(11)?.state, "closed");
  assert.ok(tracker.comments.some((c) => c.number === 11 && c.body.includes("commit/abc1234")));
  assert.deepEqual(tracker.labelsOf(17).sort(), [LABELS.failed, LABELS.proposal].sort());
  assert.equal(tracker.issues.get(17)?.state, "open"); // the owner can still read why, and re-approve
  assert.ok(tracker.comments.some((c) => c.number === 18 && c.body.includes("description changed")));
});

test("when the checks fail after apply, nothing is closed and approvals turn into failures", async () => {
  const t = fakeTracker(rules.repo, [filed(61, { type: "remove", repo: "x/y", reason: "deleted", detail: "x" })]);
  const c: Ctx = { ...ctx, gh: { rest: t.client.rest } as unknown as GitHub };
  await reportApply(c, { applied: [{ number: 61, title: "", summary: "s" }], failed: [], counts: { before: { repos: 1, categories: 1 }, after: { repos: 0, categories: 1 } }, changedFiles: [] }, { error: "verify: 2 problems" });
  assert.deepEqual(t.labelsOf(61).sort(), [LABELS.failed, LABELS.proposal].sort());
  assert.equal(t.issues.get(61)?.state, "open");
  assert.ok(t.comments[0]?.body.includes("verify: 2 problems"));
});

test("one issue that cannot be told does not stop the others, but the report still fails", async () => {
  const t = fakeTracker(rules.repo, [filed(71, { type: "remove", repo: "x/y", reason: "deleted", detail: "x" })]);
  const c: Ctx = { ...ctx, gh: { rest: t.client.rest } as unknown as GitHub };
  const counts = { before: { repos: 1, categories: 1 }, after: { repos: 1, categories: 1 } };
  const result = { applied: [], failed: [{ number: 999, title: "", error: "x" }, { number: 71, title: "", error: "y" }], counts, changedFiles: [] };
  await assert.rejects(reportApply(c, result, {}), /1 issue\(s\) could not be updated: #999/);
  assert.deepEqual(t.labelsOf(71).sort(), [LABELS.failed, LABELS.proposal].sort());
});

test("a run that stops writes nothing and tells every issue it was working on", async () => {
  const root = copyTree();
  const before = readme(root);
  const t = fakeTracker(rules.repo, [
    filed(51, { type: "remove", repo: removePath, reason: "below-floor", detail: "x" }),
    filed(52, { type: "describe", repo: englishPath, old: "stale text", new: DESC_OK, why: "x" }),
  ]);
  const c: Ctx = { ...ctx, root, gh: { ...gh, rest: t.client.rest } as unknown as GitHub };

  // a count spot that drifted: the README is not written either, although its rows changed in memory
  const site = join(root, "site/index.html");
  const siteText = readFileSync(site, "utf-8");
  const n = readBadgeCounts(before).repos;
  writeFileSync(site, siteText.replace(`${n} ხელით შერჩეული`, `${n - 3} ხელით შერჩეული`));
  const drift = await runApply(c, { dryRun: false });
  assert.match(drift.error ?? "", /site\/index\.html: says \d+ repos/);
  assert.deepEqual(drift.applied, []);
  assert.deepEqual(drift.changedFiles, []);
  assert.deepEqual(drift.counts.after, drift.counts.before); // the removal made in memory is not reported as done
  const why = Object.fromEntries(drift.failed.map((f) => [f.number, f.error]));
  assert.match(why[51] ?? "", /^the run stopped and nothing was pushed: /);
  assert.match(why[52] ?? "", /description changed/); // its own reason is kept
  assert.equal(readme(root), before);
  writeFileSync(site, siteText);

  // README rows and badges that already disagree stop the run before anything is tried
  writeFileSync(join(root, "README.md"), before.replace(`repos-${n}-00D0FF`, `repos-${n + 1}-00D0FF`));
  const off = await runApply(c, { dryRun: false });
  assert.match(off.error ?? "", /disagree/);
  assert.deepEqual(off.failed.map((f) => f.number).sort(), [51, 52]);
});
