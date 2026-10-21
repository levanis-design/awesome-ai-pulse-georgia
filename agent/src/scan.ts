/**
 * The daily scan: check every listed repo, look for new ones, and file each
 * finding as a proposal issue. Nothing here edits the collection; apply.ts
 * does that, and only for proposals the owner approved.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CategoryMeta, Rules } from "./config.js";
import { searchCandidates, trendingCandidates, type SourceReport } from "./discover.js";
import { fetchFacts, type RepoFacts } from "./facts.js";
import type { GitHub } from "./github.js";
import { descriptionProblems, draftEntry, factCheck, NoLlmError, reviewEntry, reviseEntry, type LlmConfig } from "./llm.js";
import { log } from "./log.js";
import { judgedRecently, remember, type Memory } from "./memory.js";
import { ENGLISH_MAX, ISSUE_BODY_MAX, IssueStore, isBlocked, issueBody, keyOf, LABELS, oneLine, proposalKey, ProposalSchema, type AddProposal, type IssueRecord, type Proposal, type ProposalType } from "./proposals.js";
import { allPaths, getRow, parseReadme, type ReadmeDoc } from "./readme.js";
import { addBlocker, aiSignal, belowFloor, clearsStarBar, hasStaleNote, isNewRepo, isStale, listedExclusion, ownerOf, staleNote } from "./rules.js";

export type Ctx = {
  gh: GitHub;
  rules: Rules;
  categories: CategoryMeta[];
  root: string;
  llm: LlmConfig;
  now: Date;
};

export type ScanReport = {
  started: string;
  listed: number;
  sources: SourceReport[];
  proposals: Proposal[];
  filed: Array<{ number: number; title: string }>;
  held: Array<{ key: string; why: string }>;
  skipped: Array<{ repo: string; why: string }>;
  notes: string[];
};

const REPO_PATH = /^[\w.-]+\/[\w.-]+$/;
const STYLE_EXAMPLES = ["hexgrad/kokoro", "mksglu/context-mode", "Fission-AI/OpenSpec"];

export function loadDoc(ctx: Ctx): ReadmeDoc {
  return parseReadme(readFileSync(resolve(ctx.root, "README.md"), "utf-8"), ctx.categories);
}

/** The English descriptions the MCP data and the site show, as last taken from GitHub. */
export const CACHE_FILE = "mcp/data/github-cache.json";
export type EnglishCache = Record<string, { description: string | null; fetchedAt: string }>;

export function loadEnglishCache(root: string): EnglishCache {
  try {
    return JSON.parse(readFileSync(resolve(root, CACHE_FILE), "utf-8")) as EnglishCache;
  } catch (err) {
    // no cache yet means every description is new; a broken one must not read as "all new"
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Every listed repo by its README path and by its current GitHub name, both
 * lower-cased, each pointing at the README path. A repo that moved is still
 * listed under its old address until the rename is applied.
 */
export async function listedNames(gh: GitHub, doc: ReadmeDoc, known?: Map<string, RepoFacts | null>): Promise<Map<string, string>> {
  const paths = allPaths(doc).filter((p) => REPO_PATH.test(p));
  const live = known ?? (await fetchFacts(gh, paths));
  const names = new Map(paths.map((p) => [p.toLowerCase(), p]));
  for (const p of paths) {
    const f = live.get(p.toLowerCase());
    if (f) names.set(f.nameWithOwner.toLowerCase(), p);
  }
  return names;
}

/** Health of what is already listed: excluded by the owner, gone, archived, moved, sunk under the floor, gone quiet. */
export function healthProposals(ctx: Ctx, doc: ReadmeDoc, facts: Map<string, RepoFacts | null>): Proposal[] {
  const out: Proposal[] = [];
  for (const path of allPaths(doc).filter((p) => REPO_PATH.test(p))) {
    const f = facts.get(path.toLowerCase());
    if (f === undefined) continue;
    // a repo the owner put on the exclusion list after it was listed leaves the list too
    const excluded = listedExclusion(path, f, ctx.rules);
    if (excluded) {
      out.push({ type: "remove", repo: path, reason: "excluded", detail: oneLine(excluded) });
      continue;
    }
    if (f === null) {
      out.push({ type: "remove", repo: path, reason: "deleted", detail: "GitHub ამ მისამართზე რეპოს ვეღარ პოულობს" });
      continue;
    }
    if (f.isDisabled) {
      out.push({ type: "remove", repo: path, reason: "disabled", detail: "GitHub-მა რეპო გათიშა" });
      continue;
    }
    if (f.isArchived) {
      out.push({ type: "remove", repo: path, reason: "archived", detail: `ბოლო ცვლილება ${f.pushedAt.slice(0, 10)}` });
      continue;
    }
    if (belowFloor(f.nameWithOwner, f, ctx.rules)) {
      // leaving the list: a rename or a note on top would only be noise
      out.push({ type: "remove", repo: path, reason: "below-floor", detail: `ახლა ${f.stars.toLocaleString("en-US")} ვარსკვლავი აქვს, ზღვარი ${ctx.rules.thresholds.floorIndependent.toLocaleString("en-US")}-ია` });
      continue;
    }
    if (f.nameWithOwner.toLowerCase() !== path.toLowerCase()) {
      out.push({ type: "rename", from: path, to: f.nameWithOwner });
    }
    const row = getRow(doc, path);
    if (row && isStale(f, ctx.rules, ctx.now) && !hasStaleNote(row.desc)) {
      out.push({ type: "note", repo: path, note: staleNote(f.pushedAt) });
    }
  }
  return out;
}

/** English descriptions mirror GitHub; hand-written ones for empty GitHub descriptions are kept. */
export function englishProposal(ctx: Ctx, doc: ReadmeDoc, facts: Map<string, RepoFacts | null>): Proposal | null {
  const cache = loadEnglishCache(ctx.root);
  const updates: Array<{ repo: string; description: string }> = [];
  for (const path of allPaths(doc).filter((p) => REPO_PATH.test(p))) {
    const f = facts.get(path.toLowerCase());
    const fresh = f?.description?.trim();
    if (!f || !fresh || fresh.length > ENGLISH_MAX || /[\r\n]/.test(fresh)) continue;
    if ((cache[path]?.description ?? "").trim() !== fresh) updates.push({ repo: path, description: fresh });
  }
  if (updates.length === 0) return null;
  // GitHub refuses issue bodies over 65,536 characters; what does not fit waits for the next scan
  let batch = updates;
  while (batch.length > 1 && issueBody({ type: "english", updates: batch }, ctx.categories).length > ISSUE_BODY_MAX) {
    batch = batch.slice(0, Math.floor(batch.length * 0.9));
  }
  return { type: "english", updates: batch };
}

function styleExamples(doc: ReadmeDoc): string[] {
  const picked = STYLE_EXAMPLES.map((p) => getRow(doc, p)?.desc).filter((d): d is string => !!d);
  return picked.length > 0 ? picked : doc.sections.slice(0, 3).map((s) => s.rows[0]?.desc ?? "").filter(Boolean);
}

/** `retry`: worth asking again tomorrow (a formatting slip), unlike a verdict on the repo itself. */
export type Evaluation = { proposal: AddProposal } | { skip: string; retry?: boolean };

/** Turn one unlisted repo into an `add` proposal, or say why not. */
export async function evaluateRepo(
  ctx: Ctx,
  doc: ReadmeDoc,
  f: RepoFacts,
  opts: { ownerNote?: string; requireStarBar: boolean },
): Promise<Evaluation> {
  const path = f.nameWithOwner;
  const blocker = addBlocker(f, ctx.rules, { now: ctx.now, requireStarBar: opts.requireStarBar });
  if (blocker) return { skip: blocker };
  const readme = await ctx.gh.readme(path);
  const slugs = ctx.categories.map((c) => c.slug);
  const draft = await draftEntry(ctx.llm, { facts: f, readme, slugs, examples: styleExamples(doc), ...(opts.ownerNote ? { ownerNote: opts.ownerNote } : {}) });
  if (!draft.relevant) return { skip: `not a fit for the collection: ${oneLine(String(draft.why), 200)}` };
  if (!slugs.includes(draft.category)) return { skip: `model picked unknown category '${oneLine(String(draft.category), 60)}'` };
  let description = draft.description.trim();
  const warnings: string[] = [];
  let check = await factCheck(ctx.llm, { facts: f, readme, description });
  if (!check.ok) {
    description = (await reviseEntry(ctx.llm, { facts: f, readme, description, problems: check.problems })).trim();
    check = await factCheck(ctx.llm, { facts: f, readme, description });
    if (!check.ok) warnings.push(...check.problems.slice(0, 10).map((p) => oneLine(`ფაქტების შემოწმება: ${String(p)}`)));
  }
  const shape = descriptionProblems(description);
  if (shape.length > 0) return { skip: `description failed the format check: ${shape.join("; ")}`, retry: true };
  if (draft.confidence === "low") warnings.push("მოდელი კატეგორიაში ან აღწერაში დარწმუნებული არ არის — ყურადღებით გადახედე.");
  const taken = new Set(doc.sections.flatMap((s) => s.rows.map((r) => r.name.toLowerCase())));
  // the display name becomes README link text: one short line without brackets or pipes
  const short = oneLine(String(draft.name), 60).replace(/[[\]|]/g, "").trim() || path.split("/")[1]!;
  const name = taken.has(short.toLowerCase()) ? `${short} (${ownerOf(path)})` : short;
  return {
    proposal: {
      type: "add",
      repo: path,
      name,
      category: draft.category,
      description,
      stars: f.stars,
      why: oneLine(String(draft.why)),
      warnings,
      evidence: { created: f.createdAt.slice(0, 10), stars: f.stars, forks: f.forks, watchers: f.watchers, commits: f.commits, licence: f.license, language: f.language },
    },
  };
}

export type Blocked = (p: { type: ProposalType }, key: string) => boolean;

/**
 * A changed GitHub description hints that the project changed, so those repos
 * get their Georgian entry re-read, a few per day, each at most once a month.
 * One review that fails costs only itself: the others are still filed, and only
 * a real verdict is remembered, so a failed or malformed answer is asked again tomorrow.
 */
export async function reviewProposals(
  ctx: Ctx,
  doc: ReadmeDoc,
  facts: Map<string, RepoFacts | null>,
  english: Proposal | null,
  memory: Memory,
  blocked: Blocked,
): Promise<{ proposals: Proposal[]; notes: string[] }> {
  const out: { proposals: Proposal[]; notes: string[] } = { proposals: [], notes: [] };
  if (!english || english.type !== "english") return out;
  const changed = english.updates
    .map((u) => ({ u, f: facts.get(u.repo.toLowerCase()) }))
    .filter((x): x is { u: { repo: string; description: string }; f: RepoFacts } => !!x.f)
    .filter(({ u, f }) => !judgedRecently(memory, `review:${u.repo}`, f.stars, ctx.now) && !blocked({ type: "describe" }, keyOf("describe", u.repo)))
    .sort((a, b) => b.f.stars - a.f.stars)
    .slice(0, ctx.rules.thresholds.maxDescriptionReviewsPerScan);
  for (const { u, f } of changed) {
    const row = getRow(doc, u.repo);
    if (!row) continue;
    try {
      const review = await reviewEntry(ctx.llm, { facts: f, readme: await ctx.gh.readme(f.nameWithOwner), current: row.desc });
      if (review.stillAccurate) {
        remember(memory, `review:${u.repo}`, "still accurate", f.stars, ctx.now);
        continue;
      }
      const next = typeof review.description === "string" ? review.description.trim() : "";
      const shape = descriptionProblems(next);
      if (shape.length > 0) {
        out.notes.push(`review of ${u.repo}: the new description failed the format check (${shape.join("; ")}), asked again tomorrow`);
        continue;
      }
      remember(memory, `review:${u.repo}`, "new description proposed", f.stars, ctx.now);
      out.proposals.push({ type: "describe", repo: u.repo, old: row.desc, new: next, why: oneLine(String(review.why)) });
    } catch (err) {
      out.notes.push(`review of ${u.repo} failed: ${oneLine((err as Error).message, 160)}`);
    }
  }
  return out;
}

export const NO_AI_SIGNAL = "no AI signal in its name, description or topics";

/**
 * Candidates over the star bar, new repos first (catching what just came out is
 * the point of a daily scan), then older big misses; most stars first in each.
 */
export function rankCandidates(ctx: Ctx, pool: RepoFacts[]): RepoFacts[] {
  const isNew = (f: RepoFacts) => Number(isNewRepo(f, ctx.rules, ctx.now));
  return pool.filter((f) => clearsStarBar(f, ctx.rules, ctx.now)).sort((a, b) => isNew(b) - isNew(a) || b.stars - a.stars);
}

export type CandidateRun = Pick<ScanReport, "proposals" | "skipped" | "held"> & { drafted: number };

/**
 * Walk the ranked candidates and draft entries for at most `budget` of them.
 * Everything that can be decided for free (exclusions, farming signs, no AI
 * signal, an open or rejected proposal, a recent verdict) is decided before a
 * model is asked, so the budget goes to repos that could actually be added.
 */
export async function considerCandidates(ctx: Ctx, doc: ReadmeDoc, ranked: RepoFacts[], opts: { budget: number; memory: Memory; blocked: Blocked }): Promise<CandidateRun> {
  const run: CandidateRun = { proposals: [], skipped: [], held: [], drafted: 0 };
  for (const f of ranked) {
    if (run.drafted >= opts.budget) break;
    const path = f.nameWithOwner;
    const quick = addBlocker(f, ctx.rules, { now: ctx.now, requireStarBar: true }) ?? (aiSignal(f) ? null : NO_AI_SIGNAL);
    if (quick) {
      run.skipped.push({ repo: path, why: quick });
      continue;
    }
    const key = keyOf("add", path);
    if (opts.blocked({ type: "add" }, key)) {
      run.held.push({ key, why: "already proposed, or rejected" });
      continue;
    }
    const seen = judgedRecently(opts.memory, path, f.stars, ctx.now);
    if (seen) {
      run.skipped.push({ repo: path, why: `judged ${seen.at.slice(0, 10)}: ${seen.verdict}` });
      continue;
    }
    if (!ctx.llm.apiKey) {
      run.skipped.push({ repo: path, why: `candidate (${f.stars} stars) waiting for ANTHROPIC_API_KEY` });
      continue;
    }
    try {
      run.drafted++;
      const ev = await evaluateRepo(ctx, doc, f, { requireStarBar: true });
      if ("proposal" in ev) run.proposals.push(ev.proposal);
      else {
        run.skipped.push({ repo: path, why: ev.skip });
        if (!ev.retry) remember(opts.memory, path, ev.skip, f.stars, ctx.now);
      }
    } catch (err) {
      if (err instanceof NoLlmError) break;
      run.skipped.push({ repo: path, why: `evaluation failed: ${oneLine((err as Error).message, 160)}` });
    }
  }
  return run;
}

export type ScanOptions = { dryRun: boolean; discover: boolean; maxNew?: number; memory?: Memory };

export async function runScan(ctx: Ctx, opts: ScanOptions): Promise<ScanReport> {
  const report: ScanReport = { started: ctx.now.toISOString(), listed: 0, sources: [], proposals: [], filed: [], held: [], skipped: [], notes: [] };
  const memory = opts.memory ?? {};
  const store = new IssueStore(ctx.gh, ctx.rules.repo);
  // what was proposed before decides what is still worth a model call, so it is read first
  let history: Map<string, IssueRecord[]>;
  try {
    history = await store.history();
  } catch (err) {
    if (!opts.dryRun) throw err;
    // a dry run may go on without it, but says so: what it shows may already be open or rejected
    history = new Map();
    report.notes.push(`dry run without the proposal history (${oneLine((err as Error).message, 120)}): some of these may already be proposed or rejected`);
  }
  const blocked: Blocked = (p, key) => isBlocked(p, history.get(key) ?? [], ctx.now);
  const doc = loadDoc(ctx);
  const listed = allPaths(doc).filter((p) => REPO_PATH.test(p));
  report.listed = listed.length;
  const facts = await fetchFacts(ctx.gh, listed);
  report.sources.push({ source: "listed-repos", ok: true, found: facts.size });

  const proposals: Proposal[] = [...healthProposals(ctx, doc, facts)];
  const english = englishProposal(ctx, doc, facts);
  if (english) proposals.push(english);

  const llmReady = !!ctx.llm.apiKey;
  if (!llmReady) report.notes.push("ANTHROPIC_API_KEY is not set: new repos and description reviews were not drafted.");
  if (llmReady) {
    const reviews = await reviewProposals(ctx, doc, facts, english, memory, blocked);
    proposals.push(...reviews.proposals);
    report.notes.push(...reviews.notes);
  }

  if (opts.discover) {
    const listedLower = await listedNames(ctx.gh, doc, facts);
    const search = await searchCandidates(ctx.gh, ctx.rules, ctx.now);
    const trending = await trendingCandidates(ctx.gh);
    report.sources.push(search.report, trending.report);
    const pool = [...new Set([...search.repos, ...trending.repos])].filter((p) => !listedLower.has(p.toLowerCase()));
    const poolFacts = await fetchFacts(ctx.gh, pool);
    const ranked = rankCandidates(ctx, [...poolFacts.values()].filter((f): f is RepoFacts => !!f && !listedLower.has(f.nameWithOwner.toLowerCase())));
    const run = await considerCandidates(ctx, doc, ranked, { budget: opts.maxNew ?? ctx.rules.thresholds.maxNewPerScan, memory, blocked });
    proposals.push(...run.proposals);
    report.skipped.push(...run.skipped);
    report.held.push(...run.held);
  }

  for (const p of proposals) {
    const key = proposalKey(p);
    // what is filed must read back exactly as the apply step will parse it
    const check = ProposalSchema.safeParse(p);
    if (!check.success) report.notes.push(`${key} was not filed: ${check.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    else if (blocked(p, key)) report.held.push({ key, why: "already proposed, or rejected recently" });
    else report.proposals.push(p);
  }
  if (!opts.dryRun && report.proposals.length > 0) {
    await store.ensureLabels();
    for (const p of report.proposals) {
      const issue = await store.create(p, ctx.categories);
      report.filed.push({ number: issue.number, title: issue.title });
      log.info("proposal filed", { number: issue.number, key: proposalKey(p) });
    }
  }
  return report;
}

/** Discovery found nothing because every source broke, not because nothing is new. */
export function discoveryBroken(r: ScanReport): boolean {
  const discovery = r.sources.filter((s) => s.source !== "listed-repos");
  return discovery.length > 0 && discovery.every((s) => !s.ok);
}

/** An owner's suggestion issue → a proposal (or a reasoned no), answered on the issue. */
export async function runSuggestion(ctx: Ctx, number: number, dryRun: boolean): Promise<{ outcome: string; proposal?: Proposal }> {
  const store = new IssueStore(ctx.gh, ctx.rules.repo);
  const issue = await store.get(number);
  // one suggestion can fire the workflow twice (opened + labeled); the first run closes it
  if (issue.state === "closed") return { outcome: "already handled" };
  const m = /github\.com\/([\w.-]+\/[\w.-]+)/.exec(`${issue.title}\n${issue.body}`);
  const reply = async (text: string) => {
    if (dryRun) return;
    await store.comment(number, text);
    await store.close(number, "completed");
  };
  if (!m) {
    await reply("ამ ჩანაწერში GitHub-ის რეპოს ბმული ვერ ვიპოვე. ბმულით ახალი შეთავაზება გააკეთე.");
    return { outcome: "no repo link found" };
  }
  const path = m[1]!.replace(/\.git$/, "");
  const doc = loadDoc(ctx);
  if (getRow(doc, path)) {
    await reply(`${path} უკვე სიაშია.`);
    return { outcome: "already listed" };
  }
  const f = (await fetchFacts(ctx.gh, [path])).get(path.toLowerCase());
  if (!f) {
    await reply(`GitHub-ზე ${path} ვერ ვიპოვე.`);
    return { outcome: "repo not found" };
  }
  // listed under an older address counts too: GitHub redirects that row to this repo
  const listedAs = (await listedNames(ctx.gh, doc)).get(f.nameWithOwner.toLowerCase());
  if (listedAs) {
    await reply(`${f.nameWithOwner} უკვე სიაშია${listedAs.toLowerCase() === f.nameWithOwner.toLowerCase() ? "" : ` (ძველი მისამართით: ${listedAs})`}.`);
    return { outcome: "already listed" };
  }
  // the owner's explicit suggestion overrides an earlier rejection, but not an open proposal
  const open = (await store.history()).get(keyOf("add", f.nameWithOwner))?.find((i) => i.state === "open");
  if (open) {
    await reply(`ეს რეპო უკვე შეთავაზებულია: #${open.number}.`);
    return { outcome: `already proposed as #${open.number}` };
  }
  const note = issue.body.replace(/https?:\/\/\S+/g, "").trim().slice(0, 500);
  const ev = await evaluateRepo(ctx, doc, f, { requireStarBar: false, ...(note ? { ownerNote: note } : {}) });
  if ("skip" in ev) {
    await reply(`ეს რეპო ახლა არ შევთავაზე. მიზეზი: ${ev.skip}`);
    return { outcome: ev.skip };
  }
  // a suggestion may have come through the chat, so what it leads to is approved on GitHub only
  const proposal: AddProposal = { ...ev.proposal, origin: "suggestion" };
  if (!dryRun) {
    await store.ensureLabels();
    const filed = await store.create(proposal, ctx.categories);
    await reply(`შეთავაზება მზადაა: #${filed.number}. დასამტკიცებლად იმ Issue-ს GitHub-ზე დაამატე ლეიბლი \`${LABELS.approved}\` — შეთავაზებიდან მოსულ დამატებას Grok Bot ვერ დაამტკიცებს.`);
  }
  return { outcome: "proposed", proposal };
}
