/**
 * Proposals are GitHub issues. The issue number is the proposal id the owner
 * approves (from Grok Bot or by labelling on GitHub); the body carries a
 * Georgian summary for people and a JSON block for the agent.
 */
import { z } from "zod";
import type { CategoryMeta } from "./config.js";
import { GitHubError, type GitHub, type RestClient } from "./github.js";
import { DAY_MS, ownerOf } from "./rules.js";

const repoPath = z.string().regex(/^[\w.-]+\/[\w.-]+$/);

/** Longest GitHub description the English refresh carries over (the scan skips longer ones). */
export const ENGLISH_MAX = 400;

/**
 * Text that the issue summary renders as Markdown. Much of it comes from a
 * model that read a stranger's README, so it may not break lines, open code
 * fences or write tags (the agent's own JSON block must stay the only one).
 */
const line = (max: number) => z.string().max(max).refine((s) => !/[\r\n`<>]/.test(s), "one plain line, without backticks or angle brackets");

/** Model or third-party text made safe for the summary: one line, no fences or tags, capped. */
export function oneLine(text: string, max = 300): string {
  const flat = text.replace(/`/g, "'").replace(/</g, "‹").replace(/>/g, "›").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Chat text the gateway posts on a public issue under the owner's name: one line,
 * links taken out, and @-mentions broken with a zero-width space so nobody is pinged.
 */
export function plain(text: string, max = 300): string {
  return oneLine(text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, "‹link›").replace(/@(?=[\w-])/g, "@\u200b"), max);
}

// Description lengths: wider than descriptionProblems() allows (DESC_MIN–DESC_MAX in llm.ts) on
// purpose. The schema only has to keep an issue readable; the format check is the gate.
const description = z.string().min(80).max(1500);

export const ProposalSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add"),
    repo: repoPath,
    name: line(80).refine((s) => s.length > 0 && !/[[\]|]/.test(s), "a display name the README link can hold"),
    category: z.string(),
    description,
    stars: z.number().int().nonnegative(),
    why: line(300),
    warnings: z.array(line(300)).max(12),
    evidence: z.record(z.union([z.string(), z.number(), z.null()])),
    /** drafted from an owner's suggestion issue: approved only on GitHub, never from the chat */
    origin: z.literal("suggestion").optional(),
  }),
  z.object({
    type: z.literal("remove"),
    repo: repoPath,
    reason: z.enum(["deleted", "archived", "disabled", "below-floor", "excluded"]),
    detail: line(300),
  }),
  z.object({ type: z.literal("rename"), from: repoPath, to: repoPath }),
  z.object({ type: z.literal("describe"), repo: repoPath, old: z.string(), new: description, why: line(300) }),
  z.object({ type: z.literal("note"), repo: repoPath, note: line(300).refine((s) => s.length >= 10) }),
  z.object({
    type: z.literal("english"),
    updates: z.array(z.object({ repo: repoPath, description: z.string().min(1).max(ENGLISH_MAX).refine((s) => !/[\r\n]/.test(s)) })).min(1),
  }),
]);

export type Proposal = z.infer<typeof ProposalSchema>;
export type ProposalType = Proposal["type"];
export type AddProposal = Extract<Proposal, { type: "add" }>;
export type RemoveReason = Extract<Proposal, { type: "remove" }>["reason"];

export const LABELS = {
  proposal: "agent:proposal",
  approved: "agent:approved",
  rejected: "agent:rejected",
  applied: "agent:applied",
  failed: "agent:failed",
  suggestion: "agent:suggestion",
} as const;

const LABEL_COLORS: Record<string, string> = {
  [LABELS.proposal]: "00D0FF",
  [LABELS.approved]: "2EA043",
  [LABELS.rejected]: "8B949E",
  [LABELS.applied]: "A949DA",
  [LABELS.failed]: "D73A49",
  [LABELS.suggestion]: "FBCA04",
};

/** First line of every proposal body; it names the proposal's key, which the JSON block must match. */
const HEAD = /^<!-- aipulse-agent:proposal v1 key=(\S+) -->\n/;
const FENCE = "\n```json\n";

/** GitHub refuses issue bodies longer than this (65,536), with a margin for its own counting. */
export const ISSUE_BODY_MAX = 60_000;

/**
 * Issues may be opened by anyone on a public repo, so only proposals the agent
 * filed (github-actions[bot]) or the repo owner wrote are ever approved or applied.
 */
export function isTrustedAuthor(login: string, repo: string): boolean {
  const who = login.toLowerCase();
  return who === "github-actions[bot]" || who === ownerOf(repo).toLowerCase();
}

/**
 * The one spelling of a proposal key: one open proposal per repo and kind,
 * case-insensitive; the English refresh is a single batch with no repo.
 */
export function keyOf(type: ProposalType, repo = ""): string {
  return type === "english" ? "english" : `${type}:${repo.toLowerCase()}`;
}

export function proposalKey(p: Proposal): string {
  switch (p.type) {
    case "rename":
      return keyOf(p.type, p.from);
    case "english":
      return keyOf(p.type);
    default:
      return keyOf(p.type, p.repo);
  }
}

const REMOVE_REASON: Record<RemoveReason, string> = {
  deleted: "წაშლილია",
  archived: "დაარქივდა",
  disabled: "გათიშულია",
  "below-floor": "ვარსკვლავების ზღვარს ქვემოთ ჩავიდა",
  excluded: "აკრძალულ სიაშია",
};

function cat(categories: CategoryMeta[], slug: string): string {
  const c = categories.find((x) => x.slug === slug);
  return c ? `${c.emoji} ${c.georgian}` : slug;
}

export function issueTitle(p: Proposal, categories: CategoryMeta[]): string {
  switch (p.type) {
    case "add":
      return `➕ დამატება: ${p.name} → ${cat(categories, p.category)}`;
    case "remove":
      return `➖ ამოღება: ${p.repo} (${REMOVE_REASON[p.reason]})`;
    case "rename":
      return `✏️ ახალი მისამართი: ${p.from} → ${p.to}`;
    case "describe":
      return `📝 აღწერის განახლება: ${p.repo}`;
    case "note":
      return `🕰️ შენიშვნა: ${p.repo} აღარ ახლდება`;
    case "english":
      return `🌐 ინგლისური აღწერები: ${p.updates.length} განახლება GitHub-იდან`;
  }
}

function summary(p: Proposal, categories: CategoryMeta[]): string[] {
  switch (p.type) {
    case "add":
      return [
        `**რეპო:** https://github.com/${p.repo} · ⭐ ${p.stars.toLocaleString("en-US")}`,
        `**კატეგორია:** ${cat(categories, p.category)}`,
        ...(p.origin === "suggestion" ? [`**წყარო:** ეს რეპო შენ შემომთავაზე (\`${LABELS.suggestion}\`).`] : []),
        `**რატომ:** ${oneLine(p.why)}`,
        "",
        "**აღწერა, რომელიც სიაში ჩაიწერება:**",
        "",
        `> ${p.description}`,
        ...(p.warnings.length > 0 ? ["", "**⚠️ შენიშვნები შემოწმებიდან:**", ...p.warnings.map((w) => `- ${oneLine(w)}`)] : []),
      ];
    case "remove":
      return [`**რეპო:** https://github.com/${p.repo}`, `**მიზეზი:** ${REMOVE_REASON[p.reason]} — ${oneLine(p.detail)}`];
    case "rename":
      return [`GitHub-მა რეპო ახალ მისამართზე გადაიტანა. სიაში ბმული შეიცვლება, ადგილი და აღწერა იგივე დარჩება.`, `**ძველი:** https://github.com/${p.from}`, `**ახალი:** https://github.com/${p.to}`];
    case "describe":
      return [`**რეპო:** https://github.com/${p.repo}`, `**რატომ:** ${oneLine(p.why)}`, "", "**ახლანდელი:**", "", `> ${p.old}`, "", "**ახალი:**", "", `> ${p.new}`];
    case "note":
      return [`**რეპო:** https://github.com/${p.repo}`, `აღწერის ბოლოს დაემატება: ${oneLine(p.note)}`];
    case "english":
      return [`MCP სერვერისა და საიტის ინგლისური აღწერები GitHub-ის ახლანდელ ტექსტს გაუთანაბრდება (${p.updates.length} რეპო). ქართული აღწერები არ იცვლება.`];
  }
}

/**
 * The one text the agent files for a proposal. The JSON is the schema's own parse,
 * so its keys always come in the same order: apply compares an issue with this
 * text and refuses one that differs, since the owner approved what it shows.
 */
export function issueBody(p: Proposal, categories: CategoryMeta[]): string {
  const approve =
    p.type === "add" && p.origin === "suggestion"
      ? `დასამტკიცებლად აქ დაამატე ლეიბლი \`${LABELS.approved}\` — შეთავაზებიდან მოსულ დამატებას Grok Bot ვერ დაამტკიცებს.`
      : `დასამტკიცებლად: Grok Bot-ში თქვი „დაამტკიცე #ნომერი“, ან აქ დაამატე ლეიბლი \`${LABELS.approved}\`.`;
  return [
    `<!-- aipulse-agent:proposal v1 key=${proposalKey(p)} -->`,
    ...summary(p, categories),
    "",
    "---",
    `${approve} უარისთვის — \`${LABELS.rejected}\` (და დახურე).`,
    "",
    "<details><summary>მონაცემები აგენტისთვის (JSON)</summary>",
    "",
    "```json",
    JSON.stringify(ProposalSchema.parse(p), null, 2),
    "```",
    "",
    "</details>",
  ].join("\n");
}

/** Is this issue text exactly what the agent files for its proposal? GitHub may hand it back with CRLF. */
export function isAsFiled(body: string, p: Proposal, categories: CategoryMeta[]): boolean {
  return body.replace(/\r\n/g, "\n").trimEnd() === issueBody(p, categories).trimEnd();
}

/**
 * The proposal inside an issue body, or null when the body is not ours, is
 * malformed, or its data does not match the key in its first line. Only the
 * LAST json block counts: the agent writes it at the very end, below any text
 * a model produced.
 */
export function parseIssueBody(body: string | null | undefined): Proposal | null {
  const text = (body ?? "").replace(/\r\n/g, "\n");
  const head = HEAD.exec(text);
  const open = text.lastIndexOf(FENCE);
  if (!head || open < 0) return null;
  const start = open + FENCE.length;
  const end = text.indexOf("\n```", start);
  if (end < 0) return null;
  try {
    const parsed = ProposalSchema.safeParse(JSON.parse(text.slice(start, end)));
    return parsed.success && proposalKey(parsed.data) === head[1] ? parsed.data : null;
  } catch {
    return null;
  }
}

export type IssueRecord = {
  number: number;
  state: "open" | "closed";
  title: string;
  author: string;
  labels: string[];
  createdAt: string;
  closedAt: string | null;
  url: string;
  proposal: Proposal | null;
  body: string;
};

type RawIssue = {
  number: number;
  state: "open" | "closed";
  title: string;
  body: string | null;
  user: { login: string } | null;
  labels: Array<{ name: string } | string>;
  created_at: string;
  closed_at: string | null;
  html_url: string;
  pull_request?: unknown;
};

function toRecord(i: RawIssue): IssueRecord {
  return {
    number: i.number,
    state: i.state,
    title: i.title,
    author: i.user?.login ?? "",
    labels: i.labels.map((l) => (typeof l === "string" ? l : l.name)),
    createdAt: i.created_at,
    closedAt: i.closed_at,
    url: i.html_url,
    proposal: parseIssueBody(i.body),
    body: i.body ?? "",
  };
}

/**
 * Should a fresh proposal with this key be held back? Yes while one is open;
 * yes forever for a rejected addition; yes for 90 days after any other rejection.
 * Applied proposals never block (if the condition comes back, it is news).
 */
export function isBlocked(p: { type: ProposalType }, history: IssueRecord[], now: Date): boolean {
  for (const i of history) {
    if (i.state === "open") return true;
    if (!i.labels.includes(LABELS.rejected)) continue;
    if (p.type === "add") return true;
    const closed = i.closedAt ? new Date(i.closedAt).getTime() : 0;
    if (now.getTime() - closed < 90 * DAY_MS) return true;
  }
  return false;
}

/**
 * When each issue's text was last edited (null: never), read through GraphQL in
 * batches. An issue GitHub does not answer for is left out, so the caller refuses it.
 */
export async function lastEdits(gh: Pick<GitHub, "graphqlPartial">, repo: string, numbers: number[]): Promise<Map<number, string | null>> {
  const [owner, name] = repo.split("/");
  const out = new Map<number, string | null>();
  for (let i = 0; i < numbers.length; i += 50) {
    const fields = numbers.slice(i, i + 50).map((n) => `i${n}: issue(number: ${n}) { lastEditedAt }`);
    type Answer = { repository: Record<string, { lastEditedAt: string | null } | null> | null };
    const { data, errors } = await gh.graphqlPartial<Answer>(`query { repository(owner: "${owner}", name: "${name}") { ${fields.join(" ")} } }`);
    const hard = errors.filter((e) => e.type !== "NOT_FOUND");
    if (data === null || hard.length > 0) throw new Error(`GitHub GraphQL failed: ${hard.map((e) => e.message).join("; ") || "no data returned"}`);
    for (const n of numbers.slice(i, i + 50)) {
      const issue = data.repository?.[`i${n}`];
      if (issue) out.set(n, issue.lastEditedAt);
    }
  }
  return out;
}

export class IssueStore {
  constructor(
    private readonly gh: RestClient,
    readonly repo: string,
  ) {}

  async ensureLabels(): Promise<void> {
    const have = await this.gh.rest<Array<{ name: string }>>("GET", `/repos/${this.repo}/labels?per_page=100`);
    const names = new Set(have.map((l) => l.name));
    for (const [name, color] of Object.entries(LABEL_COLORS)) {
      if (!names.has(name)) await this.gh.rest("POST", `/repos/${this.repo}/labels`, { name, color });
    }
  }

  /** Issues with a label, newest first, up to `maxPages` × 100. With `complete`, reaching that cap is an error, not a silent cut. */
  async list(opts: { label: string; state: "open" | "closed" | "all"; maxPages?: number; complete?: boolean }): Promise<IssueRecord[]> {
    const out: IssueRecord[] = [];
    const max = opts.maxPages ?? 5;
    for (let page = 1; ; page++) {
      const params = new URLSearchParams({ labels: opts.label, state: opts.state, per_page: "100", page: String(page) });
      const batch = await this.gh.rest<RawIssue[]>("GET", `/repos/${this.repo}/issues?${params}`);
      out.push(...batch.filter((i) => !i.pull_request).map(toRecord));
      if (batch.length < 100) return out;
      if (page >= max) {
        if (opts.complete) throw new Error(`more than ${max * 100} '${opts.label}' issues: the history would be incomplete`);
        return out;
      }
    }
  }

  async get(number: number): Promise<IssueRecord> {
    return toRecord(await this.gh.rest<RawIssue>("GET", `/repos/${this.repo}/issues/${number}`));
  }

  async create(p: Proposal, categories: CategoryMeta[]): Promise<IssueRecord> {
    const raw = await this.gh.rest<RawIssue>("POST", `/repos/${this.repo}/issues`, {
      title: issueTitle(p, categories),
      body: issueBody(p, categories),
      labels: [LABELS.proposal],
    });
    return toRecord(raw);
  }

  async createSuggestion(title: string, body: string): Promise<IssueRecord> {
    return toRecord(await this.gh.rest<RawIssue>("POST", `/repos/${this.repo}/issues`, { title, body, labels: [LABELS.suggestion] }));
  }

  async addLabel(number: number, label: string): Promise<void> {
    await this.gh.rest("POST", `/repos/${this.repo}/issues/${number}/labels`, { labels: [label] });
  }

  async removeLabel(number: number, label: string): Promise<void> {
    try {
      await this.gh.rest("DELETE", `/repos/${this.repo}/issues/${number}/labels/${encodeURIComponent(label)}`);
    } catch (err) {
      if (!(err instanceof GitHubError && err.status === 404)) throw err; // 404: the label was not there
    }
  }

  /** Who added the approval label most recently, or null when nobody did. Events come oldest first. */
  async approvedBy(number: number): Promise<string | null> {
    type Event = { event: string; label?: { name: string }; actor?: { login: string } | null };
    let last: string | null = null;
    for (let page = 1; page <= 10; page++) {
      const events = await this.gh.rest<Event[]>("GET", `/repos/${this.repo}/issues/${number}/events?per_page=100&page=${page}`);
      for (const e of events) if (e.event === "labeled" && e.label?.name === LABELS.approved) last = e.actor?.login ?? null;
      if (events.length < 100) return last;
    }
    throw new Error(`#${number} has more than 1,000 events, so who approved it cannot be told`);
  }

  async comment(number: number, body: string): Promise<void> {
    await this.gh.rest("POST", `/repos/${this.repo}/issues/${number}/comments`, { body });
  }

  async close(number: number, reason: "completed" | "not_planned"): Promise<void> {
    await this.gh.rest("PATCH", `/repos/${this.repo}/issues/${number}`, { state: "closed", state_reason: reason });
  }

  /** Every proposal ever filed, grouped by key, for isBlocked(). */
  async history(): Promise<Map<string, IssueRecord[]>> {
    // a rejection that fell off the end would let a "never again" repo come back, so the read must be complete
    const all = await this.list({ label: LABELS.proposal, state: "all", maxPages: 50, complete: true });
    const keys = new Map<string, IssueRecord[]>();
    for (const i of all) {
      if (!i.proposal) continue;
      const k = proposalKey(i.proposal);
      keys.set(k, [...(keys.get(k) ?? []), i]);
    }
    return keys;
  }
}
