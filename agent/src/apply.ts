/**
 * Apply approved proposals to the working tree: README rows, every count spot
 * and the English description cache. The workflow then rebuilds the derived
 * data, runs the checks, and merges only when all of them pass.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readBadgeCounts, updateCounts, type Counts } from "./counts.js";
import { fetchFacts } from "./facts.js";
import { descriptionProblems } from "./llm.js";
import { IssueStore, LABELS, trustedAuthors, type IssueRecord, type Proposal } from "./proposals.js";
import { addRow, getRow, kfmt, moveRow, removeRow, renameRow, serializeReadme, setDescription, totals, type ReadmeDoc } from "./readme.js";
import { exclusionReason, hasStaleNote } from "./rules.js";
import { loadDoc, type Ctx } from "./scan.js";

export type ApplyItem = { number: number; title: string; summary: string };
export type ApplyResult = {
  applied: ApplyItem[];
  failed: Array<{ number: number; title: string; error: string }>;
  counts: { before: Counts; after: Counts };
  changedFiles: string[];
};

const ORDER: Proposal["type"][] = ["rename", "remove", "move", "describe", "note", "add", "english"];

type Cache = Record<string, { description: string | null; fetchedAt: string }>;

/** old path (lower-case) → new path, for renames applied earlier in the same run */
type Moved = Map<string, string>;

async function applyOne(ctx: Ctx, doc: ReadmeDoc, cache: Cache, moved: Moved, p: Proposal): Promise<string> {
  const now = (path: string) => moved.get(path.toLowerCase()) ?? path;
  switch (p.type) {
    case "add": {
      const excluded = exclusionReason(p.repo, ctx.rules);
      if (excluded) throw new Error(`on the exclusion list: ${excluded}`);
      const f = (await fetchFacts(ctx.gh, [p.repo])).get(p.repo.toLowerCase());
      if (!f) throw new Error("the repo no longer exists");
      if (f.isArchived) throw new Error("the repo was archived after it was proposed");
      if (getRow(doc, f.nameWithOwner)) throw new Error("already listed");
      const shape = descriptionProblems(p.description);
      if (shape.length > 0) throw new Error(`description fails the format check: ${shape.join("; ")}`);
      addRow(doc, p.category, { name: p.name, url: `https://github.com/${f.nameWithOwner}`, stars: kfmt(f.stars), desc: p.description });
      return `დაემატა ${p.name} (${kfmt(f.stars)})`;
    }
    case "remove": {
      const row = removeRow(doc, now(p.repo));
      return `ამოღებულია ${row.name}`;
    }
    case "rename": {
      const f = (await fetchFacts(ctx.gh, [p.from])).get(p.from.toLowerCase());
      if (!f || f.nameWithOwner.toLowerCase() !== p.to.toLowerCase()) throw new Error("GitHub no longer redirects to the proposed address");
      renameRow(doc, p.from, f.nameWithOwner);
      moved.set(p.from.toLowerCase(), f.nameWithOwner);
      return `ბმული შეიცვალა: ${f.nameWithOwner}`;
    }
    case "move": {
      const row = moveRow(doc, now(p.repo), p.to);
      return `${row.name} გადავიდა ${p.to}-ში`;
    }
    case "describe": {
      const row = getRow(doc, now(p.repo));
      if (!row) throw new Error("not listed any more");
      if (row.desc !== p.old) throw new Error("the description changed since this was proposed");
      const shape = descriptionProblems(p.new);
      if (shape.length > 0) throw new Error(`description fails the format check: ${shape.join("; ")}`);
      setDescription(doc, now(p.repo), p.new);
      return `აღწერა განახლდა: ${row.name}`;
    }
    case "note": {
      const row = getRow(doc, now(p.repo));
      if (!row) throw new Error("not listed any more");
      if (hasStaleNote(row.desc)) return `${row.name}-ს შენიშვნა უკვე აქვს`;
      setDescription(doc, now(p.repo), `${row.desc} ${p.note}`);
      return `შენიშვნა დაემატა: ${row.name}`;
    }
    case "english": {
      let n = 0;
      for (const u of p.updates) {
        const path = now(u.repo);
        if (!getRow(doc, path)) continue;
        cache[path] = { description: u.description, fetchedAt: ctx.now.toISOString() };
        n++;
      }
      return `${n} ინგლისური აღწერა განახლდა`;
    }
  }
}

export async function runApply(ctx: Ctx, opts: { dryRun: boolean; numbers?: number[] }): Promise<ApplyResult> {
  const store = new IssueStore(ctx.gh, ctx.rules.repo);
  const trusted = new Set(trustedAuthors(ctx.rules.repo).map((a) => a.toLowerCase()));
  let queue: IssueRecord[] = await store.list({ label: LABELS.approved, state: "open" });
  if (opts.numbers?.length) queue = queue.filter((i) => opts.numbers!.includes(i.number));
  const result: ApplyResult = { applied: [], failed: [], counts: { before: { repos: 0, categories: 0 }, after: { repos: 0, categories: 0 } }, changedFiles: [] };

  const doc = loadDoc(ctx);
  const readmePath = resolve(ctx.root, "README.md");
  const before = totals(doc);
  const badge = readBadgeCounts(readFileSync(readmePath, "utf-8"));
  if (badge.repos !== before.repos || badge.categories !== before.categories) {
    throw new Error(`README rows (${before.repos}/${before.categories}) and badges (${badge.repos}/${badge.categories}) disagree — fix that first`);
  }
  result.counts.before = before;

  const cachePath = resolve(ctx.root, "mcp", "data", "github-cache.json");
  const cache = JSON.parse(readFileSync(cachePath, "utf-8")) as Cache;
  let cacheTouched = false;

  const runnable = queue
    .filter((i) => {
      if (!i.proposal) result.failed.push({ number: i.number, title: i.title, error: "no readable proposal in the issue" });
      else if (!trusted.has(i.author.toLowerCase())) result.failed.push({ number: i.number, title: i.title, error: `filed by ${i.author}, not by the agent or the owner` });
      else return true;
      return false;
    })
    .sort((a, b) => ORDER.indexOf(a.proposal!.type) - ORDER.indexOf(b.proposal!.type) || a.number - b.number);

  const moved: Moved = new Map();
  for (const issue of runnable) {
    try {
      const summary = await applyOne(ctx, doc, cache, moved, issue.proposal!);
      if (issue.proposal!.type === "english") cacheTouched = true;
      result.applied.push({ number: issue.number, title: issue.title, summary });
    } catch (err) {
      result.failed.push({ number: issue.number, title: issue.title, error: (err as Error).message });
    }
  }

  const after = totals(doc);
  result.counts.after = after;
  if (opts.dryRun || result.applied.length === 0) return result;

  writeFileSync(readmePath, serializeReadme(doc), "utf-8");
  result.changedFiles.push("README.md");
  if (after.repos !== before.repos || after.categories !== before.categories) {
    for (const f of updateCounts(ctx.root, before, after).keys()) if (!result.changedFiles.includes(f)) result.changedFiles.push(f);
  }
  if (cacheTouched) {
    writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf-8");
    result.changedFiles.push("mcp/data/github-cache.json");
  }
  return result;
}

/** Tell each issue how it went: applied ones are closed with the commit link, failed ones lose their approval. */
export async function reportApply(ctx: Ctx, result: ApplyResult, outcome: { changeUrl?: string; error?: string }): Promise<void> {
  const store = new IssueStore(ctx.gh, ctx.rules.repo);
  for (const a of result.applied) {
    if (outcome.changeUrl && !outcome.error) {
      await store.comment(a.number, `✅ შესრულდა: ${a.summary}. ცვლილება: ${outcome.changeUrl}`);
      await store.addLabel(a.number, LABELS.applied);
      await store.removeLabel(a.number, LABELS.approved);
      await store.close(a.number, "completed");
    } else {
      await store.comment(a.number, `⚠️ ცვლილება მომზადდა, მაგრამ შემოწმებამ ვერ გაიარა და არაფერი შეერთებულა: ${outcome.error ?? "unknown error"}`);
      await store.addLabel(a.number, LABELS.failed);
      await store.removeLabel(a.number, LABELS.approved);
    }
  }
  for (const f of result.failed) {
    await store.comment(f.number, `⚠️ ვერ შევასრულე: ${f.error}`);
    await store.addLabel(f.number, LABELS.failed);
    await store.removeLabel(f.number, LABELS.approved);
  }
}
