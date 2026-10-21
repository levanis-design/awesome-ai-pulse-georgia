/**
 * Whole flows against a fake GitHub and a stubbed Claude: a scan files its
 * proposals once and holds them the next day; an owner's suggestion ends in a
 * proposal or a reasoned no, and never in a duplicate.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import type { RepoFacts } from "../src/facts.js";
import type { GitHub } from "../src/github.js";
import type { Memory } from "../src/memory.js";
import { LABELS, parseIssueBody, type AddProposal } from "../src/proposals.js";
import { runScan, runSuggestion, type Ctx } from "../src/scan.js";
import { CATS, DESC_OK, facts, fakeGraphql, fakeTracker, issue, miniReadme, NOW, RULES } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "aipulse-flow-"));
after(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(
  join(root, "README.md"),
  miniReadme(
    ["| [Gone](https://github.com/a/gone) | 50K | წაშლილი. |", "| [Old](https://github.com/a/oldname) | 25K | ძველი სახელით. |", "| [Keep](https://github.com/a/keep) | 20K | ჩვეულებრივი. |"],
    ["| [Tts](https://github.com/b/tts) | 30K | ხმის მოდელი. |"],
  ),
);
mkdirSync(join(root, "mcp", "data"), { recursive: true });
writeFileSync(join(root, "mcp", "data", "github-cache.json"), JSON.stringify({ "b/tts": { description: "Old English text", fetchedAt: "2026-01-01T00:00:00Z" } }));

const live = new Map<string, RepoFacts>([
  ["a/keep", facts("a/keep", { description: null })],
  // GitHub moved a/oldname; the README still has the old address
  ["a/oldname", facts("a/newname", { description: null })],
  ["a/newname", facts("a/newname", { description: null })],
  ["b/tts", facts("b/tts", { description: "A rewritten voice engine" })],
  ["acme/brand-new", facts("acme/brand-new", { stars: 6_000, description: "Open-source TTS with voice cloning.", createdAt: "2026-09-30T00:00:00Z" })],
]);
const REPO = "owner/repo";
const tracker = fakeTracker(REPO, [
  issue(50, { state: "closed", body: "https://github.com/x/y", labels: [LABELS.suggestion], user: { login: "owner" } }),
  issue(51, { body: "no link here", labels: [LABELS.suggestion], user: { login: "owner" } }),
  issue(52, { body: "https://github.com/b/tts", labels: [LABELS.suggestion], user: { login: "owner" } }),
  issue(53, { body: "https://github.com/acme/brand-new\n\nხმისთვის", labels: [LABELS.suggestion], user: { login: "owner" } }),
  issue(54, { body: "https://github.com/acme/brand-new", labels: [LABELS.suggestion], user: { login: "owner" } }),
  issue(55, { body: "https://github.com/a/newname", labels: [LABELS.suggestion], user: { login: "owner" } }),
]);
const gh = { rest: tracker.client.rest, readme: async () => "# readme", graphqlPartial: fakeGraphql(live) } as unknown as GitHub;
const ctx: Ctx = { gh, rules: { ...RULES, repo: REPO }, categories: CATS, root, llm: { apiKey: "k-test", model: "m" }, now: NOW };

/** Claude, as far as these flows need it: reviews say "changed", drafts say "fits", checks pass. */
function claude(t: TestContext) {
  return t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const { system } = JSON.parse(init.body as string) as { system: string };
    const answer = system.startsWith("You maintain entries")
      ? { stillAccurate: false, description: DESC_OK, why: "პროექტი შეიცვალა." }
      : system.startsWith("You write catalogue entries")
        ? { relevant: true, category: "voice", name: "Brand New", description: DESC_OK, why: "ხმის ხელსაწყოა.", confidence: "high" }
        : { ok: true, problems: [] };
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(answer) }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
}

const memory: Memory = {};

test("a scan files each finding once, as a labelled issue the agent can read back", async (t) => {
  const f = claude(t);
  const r = await runScan(ctx, { dryRun: false, discover: false, memory });
  assert.deepEqual(r.proposals.map((p) => p.type).sort(), ["describe", "english", "remove", "rename"]);
  assert.equal(r.filed.length, 4);
  const filed = [...tracker.issues.values()].filter((i) => i.labels.some((l) => l.name === LABELS.proposal));
  assert.equal(filed.length, 4);
  const describe = filed.map((i) => parseIssueBody(i.body)).find((p) => p?.type === "describe");
  assert.deepEqual(describe, { type: "describe", repo: "b/tts", old: "ხმის მოდელი.", new: DESC_OK, why: "პროექტი შეიცვალა." });
  assert.equal(f.mock.callCount(), 1); // one review: only b/tts changed its GitHub description
  assert.equal(memory["review:b/tts"]?.verdict, "new description proposed");
});

test("the next day the same findings are held, and nothing is reviewed again", async (t) => {
  const f = claude(t);
  const r = await runScan(ctx, { dryRun: false, discover: false, memory });
  assert.deepEqual(r.proposals, []);
  assert.deepEqual(r.held.map((h) => h.key).sort(), ["english", "remove:a/gone", "rename:a/oldname"]);
  assert.equal(f.mock.callCount(), 0);
});

test("without the proposal history a real scan stops before any model call, and a dry run says what it is missing", async (t) => {
  const f = claude(t);
  const down = { ...gh, rest: async () => Promise.reject(new Error("GitHub is down")) } as unknown as GitHub;
  const blind: Ctx = { ...ctx, gh: down };
  await assert.rejects(runScan(blind, { dryRun: false, discover: false, memory: {} }), /GitHub is down/);
  assert.equal(f.mock.callCount(), 0); // the history decides what is worth asking, so nothing was asked
  const dry = await runScan(blind, { dryRun: true, discover: false, memory: {} });
  assert.ok(dry.notes.some((n) => n.startsWith("dry run without the proposal history (GitHub is down)")), dry.notes.join(" | "));
  assert.deepEqual(dry.filed, []);
});

test("suggestions: handled ones are left alone; no link, already listed and duplicates get a reason", async (t) => {
  const f = claude(t);
  assert.deepEqual(await runSuggestion(ctx, 50, false), { outcome: "already handled" });
  assert.equal(tracker.comments.filter((c) => c.number === 50).length, 0);

  assert.equal((await runSuggestion(ctx, 51, false)).outcome, "no repo link found");
  assert.equal((await runSuggestion(ctx, 52, false)).outcome, "already listed");
  // the README still has the old address, which GitHub now redirects to the suggested one
  assert.equal((await runSuggestion(ctx, 55, false)).outcome, "already listed");
  assert.ok(tracker.comments.some((c) => c.number === 55 && c.body.includes("a/oldname")));
  for (const n of [51, 52, 55]) assert.equal(tracker.issues.get(n)?.state, "closed");
  assert.equal(f.mock.callCount(), 0);

  const proposed = await runSuggestion(ctx, 53, false);
  assert.equal(proposed.outcome, "proposed");
  const filed = [...tracker.issues.values()].find((i) => parseIssueBody(i.body)?.type === "add");
  assert.ok(filed, "an add proposal was filed");
  // the chat may have made the suggestion, so the chat cannot approve what it led to
  assert.equal((parseIssueBody(filed.body) as AddProposal).origin, "suggestion");
  const answer = tracker.comments.find((c) => c.number === 53)?.body ?? "";
  assert.ok(answer.includes(`#${filed.number}`) && answer.includes("Grok Bot ვერ დაამტკიცებს"), answer);
  assert.equal(f.mock.callCount(), 2); // draft + fact check

  const again = await runSuggestion(ctx, 54, false);
  assert.equal(again.outcome, `already proposed as #${filed.number}`);
  assert.equal(f.mock.callCount(), 2); // decided without asking the model
});
