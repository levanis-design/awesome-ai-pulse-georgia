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
import { loadRules } from "../src/config.js";
import type { RepoFacts } from "../src/facts.js";
import type { GitHub } from "../src/github.js";
import type { Memory } from "../src/memory.js";
import { LABELS, parseIssueBody } from "../src/proposals.js";
import { runScan, runSuggestion, type Ctx } from "../src/scan.js";
import { CATS, DESC_OK, facts, fakeTracker, issue, miniReadme, NOW, rawRepo } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "aipulse-flow-"));
after(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(
  join(root, "README.md"),
  miniReadme(
    ["| [Gone](https://github.com/a/gone) | 50K | წაშლილი. |", "| [Keep](https://github.com/a/keep) | 20K | ჩვეულებრივი. |"],
    ["| [Tts](https://github.com/b/tts) | 30K | ხმის მოდელი. |"],
  ),
);
mkdirSync(join(root, "mcp", "data"), { recursive: true });
writeFileSync(join(root, "mcp", "data", "github-cache.json"), JSON.stringify({ "b/tts": { description: "Old English text", fetchedAt: "2026-01-01T00:00:00Z" } }));

const live = new Map<string, RepoFacts>([
  ["a/keep", facts("a/keep", { description: null })],
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
]);
const gh = {
  rest: tracker.client.rest,
  readme: async () => "# readme",
  async graphqlPartial(query: string) {
    const data: Record<string, unknown> = {};
    const errors: Array<{ type: string; message: string }> = [];
    for (const m of query.matchAll(/(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)) {
      const f = live.get(`${m[2]}/${m[3]}`);
      data[m[1]!] = f ? rawRepo(f) : null;
      if (!f) errors.push({ type: "NOT_FOUND", message: "not found" });
    }
    return { data, errors };
  },
} as unknown as GitHub;
const ctx: Ctx = { gh, rules: { ...loadRules(), repo: REPO }, categories: CATS, root, llm: { apiKey: "k-test", model: "m" }, now: NOW };

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
  assert.deepEqual(r.proposals.map((p) => p.type).sort(), ["describe", "english", "remove"]);
  assert.equal(r.filed.length, 3);
  const filed = [...tracker.issues.values()].filter((i) => i.labels.some((l) => l.name === LABELS.proposal));
  assert.equal(filed.length, 3);
  const describe = filed.map((i) => parseIssueBody(i.body)).find((p) => p?.type === "describe");
  assert.deepEqual(describe, { type: "describe", repo: "b/tts", old: "ხმის მოდელი.", new: DESC_OK, why: "პროექტი შეიცვალა." });
  assert.equal(f.mock.callCount(), 1); // one review: only b/tts changed its GitHub description
  assert.equal(memory["review:b/tts"]?.verdict, "new description proposed");
});

test("the next day the same findings are held, and nothing is reviewed again", async (t) => {
  const f = claude(t);
  const r = await runScan(ctx, { dryRun: false, discover: false, memory });
  assert.deepEqual(r.proposals, []);
  assert.deepEqual(r.held.map((h) => h.key).sort(), ["english", "remove:a/gone"]);
  assert.equal(f.mock.callCount(), 0);
});

test("suggestions: handled ones are left alone; no link, already listed and duplicates get a reason", async (t) => {
  const f = claude(t);
  assert.deepEqual(await runSuggestion(ctx, 50, false), { outcome: "already handled" });
  assert.equal(tracker.comments.filter((c) => c.number === 50).length, 0);

  assert.equal((await runSuggestion(ctx, 51, false)).outcome, "no repo link found");
  assert.equal((await runSuggestion(ctx, 52, false)).outcome, "already listed");
  for (const n of [51, 52]) assert.equal(tracker.issues.get(n)?.state, "closed");

  const proposed = await runSuggestion(ctx, 53, false);
  assert.equal(proposed.outcome, "proposed");
  const filed = [...tracker.issues.values()].find((i) => parseIssueBody(i.body)?.type === "add");
  assert.ok(filed, "an add proposal was filed");
  assert.ok(tracker.comments.some((c) => c.number === 53 && c.body.includes(`#${filed.number}`)));
  assert.equal(f.mock.callCount(), 2); // draft + fact check

  const again = await runSuggestion(ctx, 54, false);
  assert.equal(again.outcome, `already proposed as #${filed.number}`);
  assert.equal(f.mock.callCount(), 2); // decided without asking the model
});
