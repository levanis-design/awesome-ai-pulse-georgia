import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadRules } from "../src/config.js";
import { addBlocker, aiSignal, belowFloor, clearsStarBar, exclusionReason, farmingSigns, hasStaleNote, isNewRepo, isStale, isVendor, listedExclusion, staleNote } from "../src/rules.js";
import { daysAgo, facts, NOW, RULES as rules } from "./helpers.js";

// The owner's real rules are loaded only here. A listed repo the owner later excludes is
// proposed for removal by the scan, so no test holds the README against the real list.
test("the owner's own rules.json loads", () => {
  assert.doesNotThrow(() => loadRules());
});

test("a rules file with a pattern that does not compile is refused when it is loaded", () => {
  const dir = mkdtempSync(join(tmpdir(), "aipulse-rules-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "rules.json");
  writeFileSync(path, JSON.stringify({ ...rules, exclude: { ...rules.exclude, namePatterns: [{ pattern: "dsh[", reason: "x" }] } }));
  assert.throws(() => loadRules(path), /exclude\.namePatterns\.0\.pattern: not a valid regular expression/);
});

test("the owner's standing exclusions are refused, by exact path in any case", () => {
  assert.equal(exclusionReason("Wei-Shaw/sub2api", rules), "subscription pooling");
  assert.equal(exclusionReason("wei-shaw/SUB2API", rules), "subscription pooling");
  for (const path of ["p-e-w/heretic", "tornikebolokadze1-cyber/claude-code-setup", "erekle1/georgian-payments-skills", "louislva/claude-peers-mcp", "anywhere-labs/dsh-desktop"]) {
    assert.ok(exclusionReason(path, rules), path);
  }
});

test("a listed repo is excluded by its README address or by the name GitHub now gives it", () => {
  assert.equal(listedExclusion("Wei-Shaw/sub2api", null, rules), "subscription pooling");
  assert.equal(listedExclusion("old/address", facts("Wei-Shaw/sub2api"), rules), "subscription pooling");
  assert.equal(listedExclusion("old/address", facts("fine/repo"), rules), null);
  assert.equal(listedExclusion("old/address", null, rules), null);
});

test("name patterns catch new repos of an excluded kind, and nothing else", () => {
  const hits: Array<[string, RegExp]> = [
    ["someone/dsh-new-tool", /DSH/],
    ["dsh_lab/router", /DSH/],
    ["x/codex-dream-skin", /DSH/],
    ["x/claude-relay-service", /subscription/],
    ["x/subscription-pool", /subscription/],
    ["x/llm-jailbreak-prompts", /guardrail/],
    ["x/uncensored-llama", /guardrail/],
    ["x/abliterator", /guardrail/],
    ["x/ai-watermark-remover", /watermark/],
  ];
  for (const [path, why] of hits) assert.match(exclusionReason(path, rules) ?? "", why, path);
  for (const path of ["anthropics/claude-code", "x/dashboard", "x/dsharp", "openai/codex", "x/relay", "x/memcode-tools"]) {
    assert.equal(exclusionReason(path, rules), null, path);
  }
});

test("vendor owners match case-insensitively and only as the whole owner", () => {
  assert.ok(isVendor("NVIDIA/NeMo", rules));
  assert.ok(isVendor("nvidia/NeMo", rules));
  assert.ok(!isVendor("nvidia-fan/NeMo", rules));
  assert.ok(!isVendor("someone/anthropics", rules));
});

test("floor removal starts below 2,700 stars and never touches vendors", () => {
  assert.equal(belowFloor("indie/x", facts("indie/x", { stars: 2_800 }), rules), false); // hovering at the line: stays
  assert.equal(belowFloor("indie/x", facts("indie/x", { stars: 2_699 }), rules), true);
  assert.equal(belowFloor("getsentry/sentry-mcp", facts("getsentry/sentry-mcp", { stars: 934 }), rules), false);
});

test("star-farming signs: tiny fork ratio or almost no commits", () => {
  assert.equal(farmingSigns(facts("a/dsh", { stars: 8_500, forks: 21 }), rules).length, 1); // the DSH pattern, 0.0025
  assert.deepEqual(farmingSigns(facts("a/ok", { stars: 8_500, forks: 900 }), rules), []);
  assert.match(farmingSigns(facts("a/new", { stars: 3_000, forks: 300, commits: 12 }), rules)[0] ?? "", /12 commits/);
  assert.deepEqual(farmingSigns(facts("a/unknown", { stars: 3_000, forks: 300, commits: null }), rules), []);
  assert.deepEqual(farmingSigns(facts("a/small", { stars: 900, forks: 2 }), rules), []); // too small to judge
  // a lab's first public push often has a squashed history
  assert.deepEqual(farmingSigns(facts("zai-org/ZCode", { stars: 8_071, forks: 300, commits: 6 }), rules), []);
});

test("the star bar depends on age: 5K inside 60 days, 20K after", () => {
  assert.ok(isNewRepo(facts("a/x", { createdAt: daysAgo(60) }), rules, NOW));
  assert.ok(!isNewRepo(facts("a/x", { createdAt: daysAgo(61) }), rules, NOW));
  assert.ok(clearsStarBar(facts("a/x", { createdAt: daysAgo(30), stars: 5_000 }), rules, NOW));
  assert.ok(!clearsStarBar(facts("a/x", { createdAt: daysAgo(30), stars: 4_999 }), rules, NOW));
  assert.ok(!clearsStarBar(facts("a/x", { createdAt: daysAgo(300), stars: 19_999 }), rules, NOW));
  assert.ok(clearsStarBar(facts("a/x", { createdAt: daysAgo(300), stars: 20_000 }), rules, NOW));
});

test("the gates every addition passes, in order, with the reason the owner reads", () => {
  const gate = (f: ReturnType<typeof facts>, requireStarBar = false) => addBlocker(f, rules, { now: NOW, requireStarBar });
  assert.equal(gate(facts("a/fine")), null);
  assert.equal(gate(facts("Wei-Shaw/sub2api", { isFork: true })), "owner's exclusion list: subscription pooling"); // the owner's word first
  assert.equal(gate(facts("a/old", { isArchived: true })), "archived or disabled");
  assert.equal(gate(facts("a/off", { isDisabled: true })), "archived or disabled");
  assert.equal(gate(facts("a/copy", { isFork: true })), "a fork");
  assert.match(gate(facts("a/farm", { stars: 9_000, forks: 10 })) ?? "", /^star-farming signs: forks\/stars/);
  assert.equal(gate(facts("a/small", { stars: 2_999, forks: 300 })), "2999 stars, under the 3000 floor for independent projects");
  assert.equal(gate(facts("getsentry/tiny", { stars: 900, forks: 90 })), null); // vendors stay regardless of stars
  // the discovery bar only where the scan asks for it; an owner's suggestion needs the floor alone
  assert.equal(gate(facts("a/young", { createdAt: daysAgo(30), stars: 4_000 }), true), "4000 stars is under the bar for its age");
  assert.equal(gate(facts("a/young", { createdAt: daysAgo(30), stars: 4_000 })), null);
});

test("stale means 12 months without a push; archived repos are handled by removal instead", () => {
  assert.ok(isStale(facts("a/x", { pushedAt: "2025-10-01T00:00:00Z" }), rules, NOW));
  assert.ok(!isStale(facts("a/x", { pushedAt: "2025-11-30T00:00:00Z" }), rules, NOW));
  assert.ok(!isStale(facts("a/x", { pushedAt: "2024-01-01T00:00:00Z", isArchived: true }), rules, NOW));
});

test("the stale note uses the README's own wording and is recognised afterwards", () => {
  const note = staleNote("2025-05-14T10:00:00Z");
  assert.equal(note, "შენიშვნა: 2025 წლის მაისის შემდეგ აღარ განახლებულა.");
  assert.ok(hasStaleNote(`ხმის მოდელი. ${note}`));
  assert.ok(!hasStaleNote("ხმის მოდელი, რომელიც აქტიურად ვითარდება."));
});

test("every way the README has said a repo went quiet counts as a note, so no second one is proposed", () => {
  // the wordings in the README on 2026-10-21, trimmed to the remark itself
  const wordings = [
    "შენიშვნა: ეს კვლევის კოდია და 2024 წლის აგვისტოს შემდეგ აღარ განახლებულა — სასწავლოდ და ისტორიული მნიშვნელობით.",
    "შენიშვნა: ეს repo ძირითადად ისტორიული მნიშვნელობისაა და 2024 წლის ივნისის შემდეგ აღარ განახლებულა.",
    "შენიშვნა: Coqui AI კომპანია 2024 წელს დაიხურა და ეს repo 2024 წლის აგვისტოს შემდეგ აღარ განახლებულა.",
    "შენიშვნა: Bark-ის განახლებები 2024 წლის აგვისტოში შეჩერდა.",
    "შენიშვნა: 2025 წლის იანვრის შემდეგ აღარ განახლებულა — ახალი პროექტისთვის აქტიურად განვითარებადი ფრეიმვორკი აირჩიე.",
    "შენიშვნა: 2024 წლის აგვისტოს შემდეგ აღარ ვითარდება — აქტიური ალტერნატივებია Open WebUI და LibreChat.",
    // gpt4all's entry says it without "შენიშვნა:"
    "desktop GUI. **⚠️ აქტიური განვითარება შეჩერებულია**: ბოლო GitHub commit 2025 წლის მაისია.",
  ];
  for (const w of wordings) assert.ok(hasStaleNote(`ხმის მოდელი. ${w}`), w);
});

test("the free AI pre-check passes AI repos and stops the trending pages' everything-else", () => {
  const ai = [
    facts("hiyouga/LlamaFactory", { description: "Unified Efficient Fine-Tuning of 100+ LLMs & VLMs", topics: [] }),
    facts("acme/thing", { description: null, topics: ["machine-learning"] }),
    facts("acme/ai-sdk", { description: null, topics: [] }),
    facts("openai/whatever", { description: null, topics: [] }),
    facts("acme/tool", { description: "Turn any website into an API for AI agents.", topics: [] }),
  ];
  const other = [
    facts("facebook/react", { description: "The library for web and native user interfaces.", topics: ["javascript", "react", "frontend", "ui"] }),
    facts("yt-dlp/yt-dlp", { description: "A feature-rich command-line audio/video downloader", topics: ["youtube-dl", "video-downloader"] }),
    facts("kubernetes/kubernetes", { description: "Production-Grade Container Scheduling and Management", topics: ["containers", "go"] }),
    facts("rustdesk/rustdesk", { description: "An open-source remote desktop application designed for self-hosting.", topics: ["remote-desktop"] }),
  ];
  for (const f of ai) assert.ok(aiSignal(f), f.nameWithOwner);
  for (const f of other) assert.ok(!aiSignal(f), f.nameWithOwner);
});
