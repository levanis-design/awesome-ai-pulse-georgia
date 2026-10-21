import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseTrending } from "../src/discover.js";
import type { RepoFacts } from "../src/facts.js";
import { GitHub } from "../src/github.js";
import { remember, type Memory } from "../src/memory.js";
import { ISSUE_BODY_MAX, issueBody } from "../src/proposals.js";
import { parseReadme } from "../src/readme.js";
import { staleNote } from "../src/rules.js";
import { considerCandidates, discoveryBroken, englishProposal, healthProposals, listedNames, NO_AI_SIGNAL, rankCandidates, reviewProposals, type Ctx, type ScanReport } from "../src/scan.js";
import { CATS, daysAgo, DESC_OK, facts, miniReadme, NOW, RULES } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "aipulse-scan-"));
after(() => rmSync(root, { recursive: true, force: true }));
const ctx: Ctx = { gh: new GitHub(undefined), rules: RULES, categories: CATS, root, llm: { apiKey: undefined, model: "m" }, now: NOW };

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
      "| [Pool](https://github.com/Wei-Shaw/sub2api) | 9K | ეს რეპო მფლობელმა მოგვიანებით აკრძალა. |",
    ],
    [
      "| [Quiet](https://github.com/b/quiet) | 20K | ჩუმი. |",
      "| [Noted](https://github.com/b/noted) | 10K | შენიშვნით. შენიშვნა: 2024 წლის მაისის შემდეგ აღარ განახლებულა. |",
      "| [Unknown](https://github.com/b/unknown) | 9K | უცნობი. |",
    ],
  ),
  CATS,
);

test("health: excluded, gone, archived, moved, sunk under the floor and gone quiet each become one proposal", () => {
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
    // put on the exclusion list after it was listed: it leaves, whatever else is true of it
    ["wei-shaw/sub2api", facts("Wei-Shaw/sub2api", { pushedAt: "2024-01-01T00:00:00Z" })],
  ]);
  assert.deepEqual(healthProposals(ctx, doc, live), [
    { type: "remove", repo: "a/gone", reason: "deleted", detail: "GitHub ამ მისამართზე რეპოს ვეღარ პოულობს" },
    { type: "remove", repo: "a/frozen", reason: "archived", detail: "ბოლო ცვლილება 2025-02-03" },
    { type: "rename", from: "a/moved", to: "neworg/moved" },
    { type: "remove", repo: "a/sunk", reason: "below-floor", detail: "ახლა 2,600 ვარსკვლავი აქვს, ზღვარი 3,000-ია" },
    { type: "remove", repo: "Wei-Shaw/sub2api", reason: "excluded", detail: "subscription pooling" },
    { type: "note", repo: "b/quiet", note: staleNote("2025-03-09T00:00:00Z") },
  ]);
});

test("a listed repo is known by its README address and by the name GitHub now gives it", async () => {
  const live = new Map<string, RepoFacts | null>([
    ["a/moved", facts("neworg/Moved")],
    ["a/gone", null],
  ]);
  const names = await listedNames(ctx.gh, doc, live);
  assert.equal(names.get("neworg/moved"), "a/moved");
  assert.equal(names.get("a/moved"), "a/moved");
  assert.equal(names.get("a/gone"), "a/gone");
  assert.equal(names.has("a/guide/blob/main/x.md"), false); // not a repo row
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
    ["b/noted", facts("b/noted", { description: "Two\nlines" })], // the issue's JSON block could not hold it
  ]);
  assert.deepEqual(englishProposal(ctx, doc, live), {
    type: "english",
    updates: [
      { repo: "a/moved", description: "New text" },
      { repo: "b/quiet", description: "Quiet text" },
    ],
  });
});

test("a damaged description cache stops the scan instead of reading as all-new", () => {
  const broken = mkdtempSync(join(tmpdir(), "aipulse-cache-"));
  after(() => rmSync(broken, { recursive: true, force: true }));
  mkdirSync(join(broken, "mcp", "data"), { recursive: true });
  writeFileSync(join(broken, "mcp", "data", "github-cache.json"), "{ half a file");
  const live = new Map<string, RepoFacts | null>([["a/moved", facts("a/moved", { description: "New text" })]]);
  assert.throws(() => englishProposal({ ...ctx, root: broken }, doc, live), SyntaxError);
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

test("new repos are considered before older big misses; anything under its bar is dropped", () => {
  const pool = [
    facts("old/huge", { createdAt: daysAgo(700), stars: 90_000 }),
    facts("new/viral", { createdAt: daysAgo(10), stars: 6_000 }),
    facts("old/small", { createdAt: daysAgo(700), stars: 15_000 }),
    facts("new/tiny", { createdAt: daysAgo(10), stars: 4_000 }),
    facts("new/bigger", { createdAt: daysAgo(20), stars: 9_000 }),
  ];
  assert.deepEqual(rankCandidates(ctx, pool).map((f) => f.nameWithOwner), ["new/bigger", "new/viral", "old/huge"]);
});

test("everything decidable for free is decided before a model is asked, and verdicts are remembered", async (t) => {
  const aiDesc = { description: "An agent framework for LLM apps.", topics: ["llm"], createdAt: daysAgo(10) };
  const ranked = [
    facts("facebook/react", { description: "The library for web and native user interfaces.", topics: ["javascript"], stars: 240_000, forks: 50_000 }),
    facts("Wei-Shaw/sub2api", aiDesc),
    facts("farm/stars", { ...aiDesc, stars: 9_000, forks: 10 }),
    facts("old/archived", { ...aiDesc, isArchived: true }),
    facts("some/fork", { ...aiDesc, isFork: true }),
    facts("held/open", aiDesc),
    facts("judged/before", { ...aiDesc, stars: 10_000 }),
    facts("good/one", aiDesc),
    facts("good/two", aiDesc),
    facts("good/three", aiDesc),
  ];
  const memory: Memory = {};
  remember(memory, "judged/before", "not a fit for the collection: a course platform", 9_000, new Date(daysAgo(5)));
  const blocked = (_p: { type: string }, key: string) => key === "add:held/open";
  const asked: string[] = [];
  const f = t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { system: string; messages: Array<{ content: string }> };
    const repo = /"repo": "([^"]+)"/.exec(body.messages[0]!.content)?.[1] ?? "?";
    asked.push(repo);
    const fit = repo === "good/one";
    const text = body.system.startsWith("You write catalogue entries")
      ? JSON.stringify({ relevant: fit, category: "coding", name: "Good One", description: DESC_OK, why: fit ? "ფრეიმვორკია." : "სასწავლო კურსია.", confidence: "high" })
      : JSON.stringify({ ok: true, problems: [] });
    return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const withLlm: Ctx = { ...ctx, llm: { apiKey: "k-test", model: "m" }, gh: { readme: async () => "# readme" } as unknown as GitHub };
  const run = await considerCandidates(withLlm, doc, ranked, { budget: 2, memory, blocked });

  assert.equal(run.drafted, 2);
  assert.deepEqual(run.proposals.map((p) => ("repo" in p ? p.repo : "")), ["good/one"]);
  const why = Object.fromEntries(run.skipped.map((s) => [s.repo, s.why]));
  assert.equal(why["facebook/react"], NO_AI_SIGNAL);
  assert.match(why["Wei-Shaw/sub2api"] ?? "", /subscription pooling/);
  assert.match(why["farm/stars"] ?? "", /forks\/stars/);
  assert.equal(why["old/archived"], "archived or disabled"); // free, so it costs none of the budget
  assert.equal(why["some/fork"], "a fork");
  assert.match(why["judged/before"] ?? "", /^judged 2026-10-16: not a fit/);
  assert.match(why["good/two"] ?? "", /not a fit/);
  assert.equal(why["good/three"], undefined); // budget spent: left for tomorrow, not judged
  assert.deepEqual(run.held.map((h) => h.key), ["add:held/open"]);
  assert.deepEqual([...new Set(asked)], ["good/one", "good/two"]); // the model never saw the others
  assert.equal(f.mock.callCount(), 3); // good/one: draft + fact check; good/two: draft only
  assert.match(memory["good/two"]?.verdict ?? "", /not a fit/);
  assert.equal(memory["good/one"], undefined); // a proposal is tracked by its issue, not here
});

test("one failed or malformed review costs only itself, and only real verdicts are remembered", async (t) => {
  const english = { type: "english" as const, updates: [{ repo: "a/moved", description: "x" }, { repo: "b/quiet", description: "y" }, { repo: "b/unknown", description: "z" }] };
  const live = new Map<string, RepoFacts | null>([
    ["a/moved", facts("a/moved", { stars: 30_000 })],
    ["b/quiet", facts("b/quiet", { stars: 20_000 })],
    ["b/unknown", facts("b/unknown", { stars: 9_000 })],
  ]);
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { messages: Array<{ content: string }> };
    const repo = /"repo": "([^"]+)"/.exec(body.messages[0]!.content)?.[1];
    if (repo === "b/unknown") return new Response("overloaded", { status: 400 });
    const description = repo === "a/moved" ? DESC_OK : "ძალიან მოკლე.";
    const text = JSON.stringify({ stillAccurate: false, description, why: "პროექტი შეიცვალა." });
    return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const withLlm: Ctx = { ...ctx, llm: { apiKey: "k-test", model: "m" }, gh: { readme: async () => "# readme" } as unknown as GitHub };
  const memory: Memory = {};
  const r = await reviewProposals(withLlm, doc, live, english, memory, () => false);
  assert.deepEqual(r.proposals, [{ type: "describe", repo: "a/moved", old: "გადატანილი.", new: DESC_OK, why: "პროექტი შეიცვალა." }]);
  assert.match(r.notes.join(" | "), /review of b\/quiet: the new description failed the format check/);
  assert.match(r.notes.join(" | "), /review of b\/unknown failed: Anthropic API 400/);
  assert.equal(memory["review:a/moved"]?.verdict, "new description proposed");
  assert.equal(memory["review:b/quiet"], undefined); // asked again tomorrow
  assert.equal(memory["review:b/unknown"], undefined);
});

test("a scan whose every discovery source broke says so, instead of reporting nothing new", () => {
  const report = (sources: ScanReport["sources"]): ScanReport => ({ started: NOW.toISOString(), listed: 3, sources, proposals: [], filed: [], held: [], skipped: [], notes: [] });
  const listed = { source: "listed-repos", ok: true, found: 3 };
  const search = { source: "github-search", ok: true, found: 40 };
  const trending = { source: "github-trending", ok: true, found: 30 };
  assert.equal(discoveryBroken(report([listed, { ...search, ok: false }, { ...trending, ok: false }])), true);
  assert.equal(discoveryBroken(report([listed, search, { ...trending, ok: false }])), false); // one source still works
  assert.equal(discoveryBroken(report([listed])), false); // --no-discover: nothing was looked for
});

test("trending pages give each repo once, from the heading link only", () => {
  const html = readFileSync(new URL("./fixtures/trending.html", import.meta.url), "utf-8");
  assert.deepEqual(parseTrending(html), ["acme/voice-kit", "Some-Org/agent.toolkit"]);
  assert.deepEqual(parseTrending("<html><body>rate limited</body></html>"), []);
});
