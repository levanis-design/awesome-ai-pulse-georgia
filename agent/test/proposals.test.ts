import assert from "node:assert/strict";
import { test } from "node:test";
import {
  issueBody,
  issueTitle,
  IssueStore,
  isBlocked,
  LABELS,
  parseIssueBody,
  proposalKey,
  trustedAuthors,
  type IssueRecord,
  type Proposal,
} from "../src/proposals.js";
import { CATS, DESC_OK, fakeRest, issue, NOW } from "./helpers.js";

const SAMPLES: Proposal[] = [
  {
    type: "add",
    repo: "acme/voice-kit",
    name: "Voice Kit",
    category: "voice",
    description: DESC_OK,
    stars: 12_345,
    why: "ტექსტის გახმოვანების ხელსაწყოა.",
    warnings: ["ფაქტების შემოწმება: ლიცენზია README-ში არ ჩანს."],
    evidence: { created: "2026-09-01", stars: 12_345, forks: 800, commits: null, licence: "MIT" },
  },
  { type: "remove", repo: "a/big", reason: "below-floor", detail: "ახლა 2,100 ვარსკვლავი აქვს" },
  { type: "rename", from: "a/Mid", to: "neworg/mid" },
  { type: "move", repo: "a/small", from: "coding", to: "voice", why: "ხმის ხელსაწყოა." },
  { type: "describe", repo: "b/tts", old: "ხმის მოდელი.", new: DESC_OK, why: "პროექტი შეიცვალა." },
  { type: "note", repo: "b/tts", note: "შენიშვნა: 2025 წლის მაისის შემდეგ აღარ განახლებულა." },
  { type: "english", updates: [{ repo: "a/big", description: "Big agent | with a pipe, which is fine in JSON" }] },
];

test("every kind of proposal survives issue body → parse unchanged", () => {
  for (const p of SAMPLES) assert.deepEqual(parseIssueBody(issueBody(p, CATS)), p, p.type);
});

test("a body GitHub hands back with CRLF line endings still parses", () => {
  for (const p of SAMPLES) assert.deepEqual(parseIssueBody(issueBody(p, CATS).replace(/\n/g, "\r\n")), p, p.type);
});

test("bodies that are not ours, or were damaged, give null instead of a guess", () => {
  const body = issueBody(SAMPLES[0]!, CATS);
  assert.equal(parseIssueBody(null), null);
  assert.equal(parseIssueBody("just a normal issue"), null);
  assert.equal(parseIssueBody(`quoting it:\n${body}`), null); // the marker must open the body
  assert.equal(parseIssueBody(body.replace('"stars": 12345', '"stars": "many"')), null); // fails the schema
  assert.equal(parseIssueBody(body.replace('"type": "add"', '"type": "delete-everything"')), null);
  assert.equal(parseIssueBody(body.replace("```json\n{", "```json\n{{")), null); // broken JSON
});

test("titles tell the owner what and where, in Georgian", () => {
  assert.equal(issueTitle(SAMPLES[0]!, CATS), "➕ დამატება: Voice Kit → 🎙️ ხმა და მეტყველება");
  assert.match(issueTitle(SAMPLES[1]!, CATS), /ამოღება: a\/big \(~3,000 ვარსკვლავს ქვემოთ ჩავიდა\)/);
  assert.match(issueTitle(SAMPLES[6]!, CATS), /1 განახლება/);
});

test("keys: one open proposal per repo and kind, case-insensitive; English is one batch", () => {
  assert.equal(proposalKey(SAMPLES[0]!), "add:acme/voice-kit");
  assert.equal(proposalKey(SAMPLES[2]!), "rename:a/mid");
  assert.equal(proposalKey(SAMPLES[6]!), "english");
  assert.equal(proposalKey({ type: "english", updates: [{ repo: "z/z", description: "x" }] }), "english");
});

test("only the agent and the repo owner are trusted authors", () => {
  assert.deepEqual(trustedAuthors("tornikebolokadze1-cyber/awesome-ai-pulse-georgia"), ["github-actions[bot]", "tornikebolokadze1-cyber"]);
});

function record(over: Partial<IssueRecord>): IssueRecord {
  return { number: 1, state: "closed", title: "", author: "github-actions[bot]", labels: [LABELS.proposal], createdAt: "2026-01-01T00:00:00Z", closedAt: null, url: "", proposal: null, body: "", ...over };
}

test("held back: while open, forever after a rejected add, 90 days after other rejections", () => {
  const add = SAMPLES[0]!;
  const remove = SAMPLES[1]!;
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
  assert.equal(isBlocked(add, [], NOW), false);
  assert.equal(isBlocked(remove, [record({ state: "open" })], NOW), true);
  assert.equal(isBlocked(add, [record({ labels: [LABELS.rejected], closedAt: daysAgo(400) })], NOW), true);
  assert.equal(isBlocked(remove, [record({ labels: [LABELS.rejected], closedAt: daysAgo(30) })], NOW), true);
  assert.equal(isBlocked(remove, [record({ labels: [LABELS.rejected], closedAt: daysAgo(120) })], NOW), false);
  assert.equal(isBlocked(remove, [record({ labels: [LABELS.applied], closedAt: daysAgo(5) })], NOW), false); // news again
});

test("history pages through every proposal, skipping pull requests and foreign issues", async () => {
  const english = issueBody(SAMPLES[6]!, CATS);
  const page1 = Array.from({ length: 100 }, (_, k) => issue(k + 1, { body: english, labels: [LABELS.proposal], state: "closed" }));
  page1[99] = { ...page1[99]!, pull_request: {} };
  const page2 = [issue(201, { body: issueBody(SAMPLES[0]!, CATS), labels: [LABELS.proposal] }), issue(202, { body: "not ours", labels: [LABELS.proposal] })];
  const { client, calls } = fakeRest(({ path }) => (/[?&]page=1(&|$)/.test(path) ? page1 : page2));
  const history = await new IssueStore(client, "owner/repo").history();
  assert.equal(history.get("english")?.length, 99);
  assert.equal(history.get("add:acme/voice-kit")?.[0]?.number, 201);
  assert.equal(history.size, 2);
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.path, /labels=agent%3Aproposal&state=all&per_page=100&page=1/);
});

test("labels are created once, only the missing ones", async () => {
  const { client, calls } = fakeRest(({ method }) => (method === "GET" ? [{ name: LABELS.proposal }, { name: "bug" }] : {}));
  await new IssueStore(client, "owner/repo").ensureLabels();
  const created = calls.filter((c) => c.method === "POST").map((c) => (c.body as { name: string }).name);
  assert.deepEqual(created.sort(), [LABELS.applied, LABELS.approved, LABELS.failed, LABELS.rejected, LABELS.suggestion].sort());
});
