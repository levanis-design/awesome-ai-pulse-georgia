import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { loadCategories, loadRules, REPO_ROOT } from "../src/config.js";
import { allPaths, parseReadme } from "../src/readme.js";
import { aiSignal, belowFloor, clearsStarBar, exclusionReason, farmingSigns, hasStaleNote, isStale, isVendor, staleNote } from "../src/rules.js";
import { facts, NOW } from "./helpers.js";

const rules = loadRules();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

test("the owner's standing exclusions are refused, by exact path in any case", () => {
  assert.equal(exclusionReason("Wei-Shaw/sub2api", rules), "subscription pooling");
  assert.equal(exclusionReason("wei-shaw/SUB2API", rules), "subscription pooling");
  for (const path of ["p-e-w/heretic", "tornikebolokadze1-cyber/claude-code-setup", "erekle1/georgian-payments-skills", "louislva/claude-peers-mcp", "anywhere-labs/dsh-desktop"]) {
    assert.ok(exclusionReason(path, rules), path);
  }
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

test("no repo in the README is on the exclusion list", () => {
  const doc = parseReadme(readFileSync(resolve(REPO_ROOT, "README.md"), "utf-8"), loadCategories());
  const hits = allPaths(doc).filter((p) => exclusionReason(p, rules) !== null);
  assert.deepEqual(hits, []);
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
  assert.ok(clearsStarBar(facts("a/x", { createdAt: daysAgo(30), stars: 5_000 }), rules, NOW));
  assert.ok(!clearsStarBar(facts("a/x", { createdAt: daysAgo(30), stars: 4_999 }), rules, NOW));
  assert.ok(!clearsStarBar(facts("a/x", { createdAt: daysAgo(300), stars: 19_999 }), rules, NOW));
  assert.ok(clearsStarBar(facts("a/x", { createdAt: daysAgo(300), stars: 20_000 }), rules, NOW));
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

test("a staleness remark in other words also counts, so no second note is proposed", () => {
  // nomic-ai/gpt4all's entry says it this way, without "შენიშვნა:"
  assert.ok(hasStaleNote("desktop GUI. **⚠️ აქტიური განვითარება შეჩერებულია**: ბოლო GitHub commit 2025 წლის მაისია."));
  assert.ok(hasStaleNote("2024 წლის აგვისტოს შემდეგ აღარ ვითარდება."));
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

test("every dated note already in the README counts as a note", () => {
  const doc = parseReadme(readFileSync(resolve(REPO_ROOT, "README.md"), "utf-8"), loadCategories());
  const noted = doc.sections.flatMap((s) => s.rows).filter((r) => /შენიშვნა:.*20\d\d წ/.test(r.desc));
  assert.ok(noted.length >= 6);
  for (const r of noted) assert.ok(hasStaleNote(r.desc), r.name);
});
