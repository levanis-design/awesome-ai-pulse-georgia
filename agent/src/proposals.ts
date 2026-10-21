/**
 * Proposals are GitHub issues. The issue number is the proposal id the owner
 * approves (from Grok Bot or by labelling on GitHub); the body carries a
 * Georgian summary for people and a JSON block for the agent.
 */
import { z } from "zod";
import type { CategoryMeta } from "./config.js";
import type { RestClient } from "./github.js";

const repoPath = z.string().regex(/^[\w.-]+\/[\w.-]+$/);

export const ProposalSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add"),
    repo: repoPath,
    name: z.string().min(1).max(80),
    category: z.string(),
    description: z.string().min(80).max(1500),
    stars: z.number().int().nonnegative(),
    why: z.string(),
    warnings: z.array(z.string()),
    evidence: z.record(z.union([z.string(), z.number(), z.null()])),
  }),
  z.object({
    type: z.literal("remove"),
    repo: z.string().min(3),
    reason: z.enum(["deleted", "archived", "disabled", "below-floor", "other"]),
    detail: z.string(),
  }),
  z.object({ type: z.literal("rename"), from: repoPath, to: repoPath }),
  z.object({ type: z.literal("move"), repo: repoPath, from: z.string(), to: z.string(), why: z.string() }),
  z.object({ type: z.literal("describe"), repo: repoPath, old: z.string(), new: z.string().min(80).max(1500), why: z.string() }),
  z.object({ type: z.literal("note"), repo: repoPath, note: z.string().min(10) }),
  z.object({
    type: z.literal("english"),
    updates: z.array(z.object({ repo: repoPath, description: z.string().min(1).max(400) })).min(1),
  }),
]);

export type Proposal = z.infer<typeof ProposalSchema>;
export type ProposalType = Proposal["type"];

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

const MARKER = "<!-- aipulse-agent:proposal v1 -->";

/** GitHub refuses issue bodies longer than this (65,536), with a margin for its own counting. */
export const ISSUE_BODY_MAX = 60_000;

/**
 * Issues may be opened by anyone on a public repo, so only proposals the agent
 * filed (github-actions[bot]) or the repo owner wrote are ever approved or applied.
 */
export function trustedAuthors(repo: string): string[] {
  return ["github-actions[bot]", repo.split("/")[0] ?? ""];
}

/** One open proposal per repo and kind; the English refresh is a single batch. */
export function proposalKey(p: Proposal): string {
  switch (p.type) {
    case "rename":
      return `rename:${p.from.toLowerCase()}`;
    case "english":
      return "english";
    default:
      return `${p.type}:${p.repo.toLowerCase()}`;
  }
}

const REMOVE_REASON: Record<string, string> = {
  deleted: "წაშლილია",
  archived: "დაარქივდა",
  disabled: "გათიშულია",
  "below-floor": "~3,000 ვარსკვლავს ქვემოთ ჩავიდა",
  other: "სხვა მიზეზი",
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
    case "move":
      return `↔️ გადატანა: ${p.repo} → ${cat(categories, p.to)}`;
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
        `**რატომ:** ${p.why}`,
        "",
        "**აღწერა, რომელიც სიაში ჩაიწერება:**",
        "",
        `> ${p.description}`,
        ...(p.warnings.length > 0 ? ["", "**⚠️ შენიშვნები შემოწმებიდან:**", ...p.warnings.map((w) => `- ${w}`)] : []),
      ];
    case "remove":
      return [`**რეპო:** ${p.repo.includes("://") ? p.repo : `https://github.com/${p.repo}`}`, `**მიზეზი:** ${REMOVE_REASON[p.reason]} — ${p.detail}`];
    case "rename":
      return [`GitHub-მა რეპო ახალ მისამართზე გადაიტანა. სიაში ბმული შეიცვლება, ადგილი და აღწერა იგივე დარჩება.`, `**ძველი:** https://github.com/${p.from}`, `**ახალი:** https://github.com/${p.to}`];
    case "move":
      return [`**რეპო:** https://github.com/${p.repo}`, `**საიდან:** ${cat(categories, p.from)}`, `**სად:** ${cat(categories, p.to)}`, `**რატომ:** ${p.why}`];
    case "describe":
      return [`**რეპო:** https://github.com/${p.repo}`, `**რატომ:** ${p.why}`, "", "**ახლანდელი:**", "", `> ${p.old}`, "", "**ახალი:**", "", `> ${p.new}`];
    case "note":
      return [`**რეპო:** https://github.com/${p.repo}`, `აღწერის ბოლოს დაემატება: ${p.note}`];
    case "english":
      return [`MCP სერვერისა და საიტის ინგლისური აღწერები GitHub-ის ახლანდელ ტექსტს გაუთანაბრდება (${p.updates.length} რეპო). ქართული აღწერები არ იცვლება.`];
  }
}

export function issueBody(p: Proposal, categories: CategoryMeta[]): string {
  return [
    MARKER,
    ...summary(p, categories),
    "",
    "---",
    "დასამტკიცებლად: Grok Bot-ში თქვი „დაამტკიცე #ნომერი“, ან აქ დაამატე label `agent:approved`. უარისთვის — `agent:rejected`.",
    "",
    "<details><summary>მონაცემები აგენტისთვის (JSON)</summary>",
    "",
    "```json",
    JSON.stringify(p, null, 2),
    "```",
    "",
    "</details>",
  ].join("\n");
}

/** The proposal inside an issue body, or null when the body is not ours or is malformed. */
export function parseIssueBody(body: string | null | undefined): Proposal | null {
  if (!body || !body.startsWith(MARKER)) return null;
  const m = /```json\n([\s\S]*?)\n```/.exec(body.replace(/\r\n/g, "\n"));
  if (!m) return null;
  try {
    const parsed = ProposalSchema.safeParse(JSON.parse(m[1]!));
    return parsed.success ? parsed.data : null;
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
export function isBlocked(p: { type: ProposalType }, history: IssueRecord[], now = new Date()): boolean {
  for (const i of history) {
    if (i.state === "open") return true;
    if (!i.labels.includes(LABELS.rejected)) continue;
    if (p.type === "add") return true;
    const closed = i.closedAt ? new Date(i.closedAt).getTime() : 0;
    if (now.getTime() - closed < 90 * 86_400_000) return true;
  }
  return false;
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

  async list(opts: { label: string; state: "open" | "closed" | "all"; maxPages?: number }): Promise<IssueRecord[]> {
    const out: IssueRecord[] = [];
    for (let page = 1; page <= (opts.maxPages ?? 5); page++) {
      const params = new URLSearchParams({ labels: opts.label, state: opts.state, per_page: "100", page: String(page) });
      const batch = await this.gh.rest<RawIssue[]>("GET", `/repos/${this.repo}/issues?${params}`);
      out.push(...batch.filter((i) => !i.pull_request).map(toRecord));
      if (batch.length < 100) break;
    }
    return out;
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
    } catch {
      // the label was not there
    }
  }

  async comment(number: number, body: string): Promise<void> {
    await this.gh.rest("POST", `/repos/${this.repo}/issues/${number}/comments`, { body });
  }

  async close(number: number, reason: "completed" | "not_planned"): Promise<void> {
    await this.gh.rest("PATCH", `/repos/${this.repo}/issues/${number}`, { state: "closed", state_reason: reason });
  }

  /** Every proposal ever filed, grouped by key, for isBlocked(). */
  async history(): Promise<Map<string, IssueRecord[]>> {
    const all = await this.list({ label: LABELS.proposal, state: "all", maxPages: 10 });
    const keys = new Map<string, IssueRecord[]>();
    for (const i of all) {
      if (!i.proposal) continue;
      const k = proposalKey(i.proposal);
      keys.set(k, [...(keys.get(k) ?? []), i]);
    }
    return keys;
  }
}
