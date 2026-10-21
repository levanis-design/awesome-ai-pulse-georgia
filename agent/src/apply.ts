/**
 * Apply approved proposals to the working tree: README rows, every count spot
 * and the English description cache. The workflow then rebuilds the derived
 * data, runs the checks, and pushes only when all of them pass.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readBadgeCounts, updateCounts, type Counts } from "./counts.js";
import { fetchFacts } from "./facts.js";
import { descriptionProblems } from "./llm.js";
import { isAsFiled, IssueStore, isTrustedAuthor, LABELS, lastEdits, type AddProposal, type IssueRecord, type Proposal, type ProposalType, type RemoveReason } from "./proposals.js";
import { addRow, getRow, kfmt, removeRow, renameRow, serializeReadme, setDescription, totals, type ReadmeDoc } from "./readme.js";
import { addBlocker, belowFloor, exclusionReason, hasStaleNote, isStale, listedExclusion, ownerOf, staleNote } from "./rules.js";
import { CACHE_FILE, listedNames, loadDoc, loadEnglishCache, type Ctx, type EnglishCache } from "./scan.js";

export type ApplyItem = { number: number; title: string; summary: string };
export type ApplyResult = {
  applied: ApplyItem[];
  failed: Array<{ number: number; title: string; error: string }>;
  counts: { before: Counts; after: Counts };
  changedFiles: string[];
  /** set when the run itself stopped; every issue it was working on is then in `failed` */
  error?: string;
};

/** Renames first, so later proposals of the same run may still name the old address. */
const ORDER: Record<ProposalType, number> = { rename: 0, remove: 1, describe: 2, note: 3, add: 4, english: 5 };

/** What one run works on, shared by all of its proposals. */
type Run = {
  ctx: Ctx;
  doc: ReadmeDoc;
  cache: EnglishCache;
  /** old path (lower-case) → new path, for renames applied earlier in the same run */
  moved: Map<string, string>;
  /** listed repos by README path and by current GitHub name; read once, by the first addition */
  listed: () => Promise<Map<string, string>>;
};

async function applyAdd(run: Run, p: AddProposal): Promise<string> {
  const { ctx, doc } = run;
  const excluded = exclusionReason(p.repo, ctx.rules);
  if (excluded) throw new Error(`on the exclusion list: ${excluded}`);
  const f = (await fetchFacts(ctx.gh, [p.repo])).get(p.repo.toLowerCase());
  if (!f) throw new Error("the repo no longer exists");
  const listedAs = getRow(doc, f.nameWithOwner) ? f.nameWithOwner : (await run.listed()).get(f.nameWithOwner.toLowerCase());
  if (listedAs) throw new Error(`already listed as ${listedAs}`);
  // the same gates the scan used, on today's numbers
  const blocker = addBlocker(f, ctx.rules, { now: ctx.now, requireStarBar: false });
  if (blocker) throw new Error(blocker);
  const shape = descriptionProblems(p.description);
  if (shape.length > 0) throw new Error(`description fails the format check: ${shape.join("; ")}`);
  addRow(doc, p.category, { name: p.name, url: `https://github.com/${f.nameWithOwner}`, stars: kfmt(f.stars), desc: p.description });
  return `დაემატა ${p.name} (${kfmt(f.stars)})`;
}

/** Does the reason a repo was proposed for removal still hold, on today's facts? */
async function removalHolds(ctx: Ctx, path: string, reason: RemoveReason): Promise<boolean> {
  const f = (await fetchFacts(ctx.gh, [path])).get(path.toLowerCase()) ?? null;
  switch (reason) {
    case "deleted":
      return f === null;
    case "archived":
      return f?.isArchived === true;
    case "disabled":
      return f?.isDisabled === true;
    case "below-floor":
      return f !== null && belowFloor(f.nameWithOwner, f, ctx.rules);
    case "excluded":
      return listedExclusion(path, f, ctx.rules) !== null;
  }
}

async function applyOne(run: Run, p: Proposal): Promise<string> {
  const { ctx, doc, cache, moved } = run;
  const currentPath = (path: string) => moved.get(path.toLowerCase()) ?? path;
  switch (p.type) {
    case "add":
      return applyAdd(run, p);
    case "remove": {
      const path = currentPath(p.repo);
      // a repo that came back since the scan stays listed
      if (!(await removalHolds(ctx, path, p.reason))) throw new Error(`the reason (${p.reason}) no longer holds today`);
      const row = removeRow(doc, path);
      return `ამოღებულია ${row.name}`;
    }
    case "rename": {
      const f = (await fetchFacts(ctx.gh, [p.from])).get(p.from.toLowerCase());
      if (!f || f.nameWithOwner.toLowerCase() !== p.to.toLowerCase()) throw new Error("GitHub no longer redirects to the proposed address");
      renameRow(doc, p.from, f.nameWithOwner);
      moved.set(p.from.toLowerCase(), f.nameWithOwner);
      return `ბმული შეიცვალა: ${f.nameWithOwner}`;
    }
    case "describe": {
      const row = getRow(doc, currentPath(p.repo));
      if (!row) throw new Error("not listed any more");
      if (row.desc !== p.old) throw new Error("the description changed since this was proposed");
      const shape = descriptionProblems(p.new);
      if (shape.length > 0) throw new Error(`description fails the format check: ${shape.join("; ")}`);
      setDescription(doc, currentPath(p.repo), p.new);
      return `აღწერა განახლდა: ${row.name}`;
    }
    case "note": {
      const path = currentPath(p.repo);
      const row = getRow(doc, path);
      if (!row) throw new Error("not listed any more");
      if (hasStaleNote(row.desc)) return `${row.name}-ს შენიშვნა უკვე აქვს`;
      // only the note today's facts give, never free text carried in an issue
      const f = (await fetchFacts(ctx.gh, [path])).get(path.toLowerCase());
      if (!f || !isStale(f, ctx.rules, ctx.now)) throw new Error("not quiet any more: pushed to, archived or deleted since");
      if (p.note !== staleNote(f.pushedAt)) throw new Error("the note is not the one the repo's last push gives");
      setDescription(doc, path, `${row.desc} ${p.note}`);
      return `შენიშვნა დაემატა: ${row.name}`;
    }
    case "english": {
      const paths = p.updates.map((u) => currentPath(u.repo));
      const live = await fetchFacts(ctx.gh, paths);
      let n = 0;
      p.updates.forEach((u, k) => {
        const path = paths[k]!;
        // only GitHub's own text as it reads today, so an issue cannot put words in a repo's mouth
        if (!getRow(doc, path) || live.get(path.toLowerCase())?.description?.trim() !== u.description) return;
        cache[path] = { description: u.description, fetchedAt: ctx.now.toISOString() };
        n++;
      });
      // nothing left to write is not an applied change: no commit is made for it
      if (n === 0) throw new Error("GitHub says something else today for every one of these, or they are not listed any more; the next scan proposes fresh texts");
      const skipped = p.updates.length - n;
      return `${n} ინგლისური აღწერა განახლდა${skipped ? `; ${skipped} გამოტოვდა, რადგან GitHub-ზე ტექსტი მას შემდეგ შეიცვალა ან რეპო სიაში აღარაა` : ""}`;
    }
  }
}

const AFRESH = "close it, and the scan or a new suggestion proposes it afresh";

/** Why an approved issue may not run, or null when it may. */
async function refusal(ctx: Ctx, i: IssueRecord, store: IssueStore, edits: Map<number, string | null> | Error): Promise<string | null> {
  if (!i.proposal) return "no readable proposal in the issue";
  if (!isTrustedAuthor(i.author, ctx.rules.repo)) return `filed by ${i.author}, not by the agent or the owner`;
  if (i.labels.includes(LABELS.rejected)) return `it also carries ${LABELS.rejected}`;
  // the owner approved what the issue shows, so it must still be exactly what the agent filed
  if (!isAsFiled(i.body, i.proposal, ctx.categories)) return `the issue text is not what the agent files for this proposal; ${AFRESH}`;
  if (edits instanceof Error) return `whether the issue was edited could not be read: ${edits.message}`;
  if (!edits.has(i.number)) return "whether the issue was edited could not be read";
  const edited = edits.get(i.number);
  if (edited) return `the issue was edited on ${edited.slice(0, 10)}, and an edited proposal is never applied; ${AFRESH}`;
  // the label IS the approval, so the owner's own account must have added it
  try {
    const by = await store.approvedBy(i.number);
    return by?.toLowerCase() === ownerOf(ctx.rules.repo).toLowerCase() ? null : `approved by ${by ?? "nobody"}, not by the owner`;
  } catch (err) {
    return `who approved it could not be read: ${(err as Error).message}`;
  }
}

/** Carry out the runnable issues on the README in memory, then write every file at once. */
async function applyAll(ctx: Ctx, runnable: IssueRecord[], result: ApplyResult, dryRun: boolean): Promise<void> {
  const doc = loadDoc(ctx);
  const before = totals(doc);
  result.counts = { before, after: before };
  const badge = readBadgeCounts(readFileSync(resolve(ctx.root, "README.md"), "utf-8"));
  if (badge.repos !== before.repos || badge.categories !== before.categories) {
    throw new Error(`README rows (${before.repos}/${before.categories}) and badges (${badge.repos}/${badge.categories}) disagree — fix that first`);
  }
  const cache = loadEnglishCache(ctx.root);
  const cacheBefore = JSON.stringify(cache);
  let listed: Promise<Map<string, string>> | undefined;
  const run: Run = { ctx, doc, cache, moved: new Map(), listed: () => (listed ??= listedNames(ctx.gh, doc)) };

  for (const issue of [...runnable].sort((a, b) => ORDER[a.proposal!.type] - ORDER[b.proposal!.type] || a.number - b.number)) {
    try {
      const summary = await applyOne(run, issue.proposal!);
      result.applied.push({ number: issue.number, title: issue.title, summary });
    } catch (err) {
      result.failed.push({ number: issue.number, title: issue.title, error: (err as Error).message });
    }
  }
  const after = totals(doc);
  result.counts.after = after;
  if (dryRun || result.applied.length === 0) return;

  // every file is prepared and every count spot checked before the first one is written
  const files = new Map([["README.md", serializeReadme(doc)]]);
  if (after.repos !== before.repos || after.categories !== before.categories) {
    for (const [f, text] of updateCounts(ctx.root, before, after, { write: false, seed: files })) files.set(f, text);
  }
  if (JSON.stringify(cache) !== cacheBefore) files.set(CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`);
  for (const [f, text] of files) writeFileSync(resolve(ctx.root, f), text, "utf-8");
  result.changedFiles = [...files.keys()];
}

export async function runApply(ctx: Ctx, opts: { dryRun: boolean; numbers?: number[] }): Promise<ApplyResult> {
  const store = new IssueStore(ctx.gh, ctx.rules.repo);
  let queue: IssueRecord[] = await store.list({ label: LABELS.approved, state: "open" });
  if (opts.numbers?.length) queue = queue.filter((i) => opts.numbers!.includes(i.number));
  const edits = await lastEdits(ctx.gh, ctx.rules.repo, queue.map((i) => i.number)).catch((err: unknown) => err as Error);
  const zero = { repos: 0, categories: 0 };
  const result: ApplyResult = { applied: [], failed: [], counts: { before: zero, after: zero }, changedFiles: [] };

  const runnable: IssueRecord[] = [];
  for (const i of queue) {
    const why = await refusal(ctx, i, store, edits);
    if (why) result.failed.push({ number: i.number, title: i.title, error: why });
    else runnable.push(i);
  }

  try {
    await applyAll(ctx, runnable, result, opts.dryRun);
    return result;
  } catch (err) {
    // the run itself stopped (README and badges disagree, a count spot drifted, a file would not
    // write): nothing is pushed, every issue it was working on is told why, and no half-applied
    // field of the result survives
    const error = (err as Error).message;
    const told = new Set(result.failed.map((f) => f.number));
    const stopped = runnable.filter((i) => !told.has(i.number)).map((i) => ({ number: i.number, title: i.title, error: `the run stopped and nothing was pushed: ${error}` }));
    return { applied: [], failed: [...result.failed, ...stopped], counts: { before: result.counts.before, after: result.counts.before }, changedFiles: [], error };
  }
}

/**
 * Tell each issue how it went: applied ones are closed with the commit link, failed ones lose
 * their approval. One issue that cannot be updated does not stop the others; the run fails after.
 */
export async function reportApply(ctx: Ctx, result: ApplyResult, outcome: { changeUrl?: string; error?: string }): Promise<void> {
  const store = new IssueStore(ctx.gh, ctx.rules.repo);
  const problems: string[] = [];
  const tell = async (number: number, steps: () => Promise<void>) => {
    try {
      await steps();
    } catch (err) {
      problems.push(`#${number}: ${(err as Error).message.slice(0, 200)}`);
    }
  };
  const fail = async (number: number, text: string) => {
    await store.comment(number, text);
    await store.addLabel(number, LABELS.failed);
    await store.removeLabel(number, LABELS.approved);
  };
  for (const a of result.applied) {
    await tell(a.number, async () => {
      if (!outcome.changeUrl || outcome.error) {
        await fail(a.number, `⚠️ ცვლილება მომზადდა, მაგრამ შემოწმებამ ვერ გაიარა და არაფერი შეერთებულა: ${outcome.error ?? "unknown error"}`);
        return;
      }
      await store.comment(a.number, `✅ შესრულდა: ${a.summary}. ცვლილება: ${outcome.changeUrl}`);
      await store.addLabel(a.number, LABELS.applied);
      await store.removeLabel(a.number, LABELS.approved);
      await store.close(a.number, "completed");
    });
  }
  for (const f of result.failed) await tell(f.number, () => fail(f.number, `⚠️ ვერ შევასრულე: ${f.error}`));
  if (problems.length > 0) throw new Error(`${problems.length} issue(s) could not be updated: ${problems.join("; ")}`);
}
