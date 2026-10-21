/** Shared fixtures: a tiny README, repo facts, frozen rules, and a fake GitHub that records every call. */
import { fileURLToPath } from "node:url";
import { loadRules, type CategoryMeta, type Rules } from "../src/config.js";
import type { RepoFacts } from "../src/facts.js";
import { GitHubError, type RestClient } from "../src/github.js";
import { LABELS } from "../src/proposals.js";
import { TABLE_HEAD, TABLE_RULE } from "../src/readme.js";
import { DAY_MS } from "../src/rules.js";

export const NOW = new Date("2026-10-21T12:00:00Z");

/** NOW minus n days, as GitHub writes dates. */
export const daysAgo = (n: number): string => new Date(NOW.getTime() - n * DAY_MS).toISOString();

/**
 * The rules as they stood when these tests were written. Tests read numbers
 * from this copy, never from config/rules.json, so the owner can change a rule
 * without breaking the checks the apply step runs.
 */
export const RULES: Rules = loadRules(fileURLToPath(new URL("./fixtures/rules.json", import.meta.url)));

export const CATS: CategoryMeta[] = [
  { slug: "coding", emoji: "🤖", georgian: "კოდინგ აგენტები", english: "Coding" },
  { slug: "voice", emoji: "🎙️", georgian: "ხმა და მეტყველება", english: "Voice" },
];

/** A README with the real layout: overview table, then one table per category. */
export function miniReadme(coding: string[], voice: string[], eol = "\r\n"): string {
  return [
    "# Title",
    "",
    "## 🗂️ კატეგორიები",
    "",
    "| კატეგორია | რა არის აქ |",
    "|---|---|",
    "| 🤖 [კოდინგ აგენტები](#x) | rule |",
    "",
    "---",
    "",
    "## 🤖 კოდინგ აგენტები",
    "",
    "> **Coding** — intro.",
    "",
    TABLE_HEAD,
    TABLE_RULE,
    ...coding,
    "",
    "---",
    "",
    "## 🎙️ ხმა და მეტყველება",
    "",
    "> **Voice** — intro.",
    "",
    TABLE_HEAD,
    TABLE_RULE,
    ...voice,
    "",
    "## ჩვენს შესახებ",
    "",
  ].join(eol);
}

export const MINI = miniReadme(
  [
    "| [Big](https://github.com/a/big) | 90K | დიდი აგენტი. |",
    "| [Mid](https://github.com/a/mid) | 12K | საშუალო აგენტი. |",
    "| [Small](https://github.com/a/small) | 4.5K | პატარა აგენტი. |",
  ],
  ["| [Tts](https://github.com/b/tts) | 30K | ხმის მოდელი. |"],
);

/** A description that passes descriptionProblems(): Georgian, 200+ characters, one sentence end. */
export const DESC_OK =
  "Voice Kit ღია კოდის ბიბლიოთეკაა, რომელიც ტექსტს ბუნებრივ მეტყველებად აქცევს და ლოკალურად მუშაობს. მას შეუძლია ხმის კლონირება რამდენიმე წამიანი ჩანაწერიდან, ნაკადური გენერაცია რეალურ დროში და ათზე მეტი ენის მხარდაჭერა. Python, MIT.";

export function facts(path: string, over: Partial<RepoFacts> = {}): RepoFacts {
  return {
    nameWithOwner: path,
    isArchived: false,
    isFork: false,
    isDisabled: false,
    stars: 10_000,
    forks: 900,
    watchers: 120,
    commits: 800,
    pushedAt: "2026-10-01T00:00:00Z",
    createdAt: "2024-01-01T00:00:00Z",
    description: "A tool.",
    license: "MIT",
    language: "Python",
    topics: [],
    homepage: null,
    ...over,
  };
}

/** The GraphQL shape fetchFacts() reads. */
export function rawRepo(f: RepoFacts): Record<string, unknown> {
  return {
    nameWithOwner: f.nameWithOwner,
    isArchived: f.isArchived,
    isFork: f.isFork,
    isDisabled: f.isDisabled,
    stargazerCount: f.stars,
    forkCount: f.forks,
    watchers: { totalCount: f.watchers },
    pushedAt: f.pushedAt,
    createdAt: f.createdAt,
    description: f.description,
    homepageUrl: f.homepage,
    licenseInfo: f.license ? { spdxId: f.license } : null,
    primaryLanguage: f.language ? { name: f.language } : null,
    repositoryTopics: { nodes: f.topics.map((name) => ({ topic: { name } })) },
    defaultBranchRef: { target: { history: { totalCount: f.commits } } },
  };
}

/**
 * GitHub's GraphQL, as fetchFacts() and lastEdits() ask it: repos come from `live`
 * (a missing one is deleted); issues were never edited unless `edited` dates them,
 * and GitHub gives no answer at all for the `unanswered` ones.
 */
export function fakeGraphql(live: Map<string, RepoFacts>, issues: { edited?: Record<number, string>; unanswered?: number[] } = {}) {
  return async (query: string) => {
    const data: Record<string, unknown> = {};
    const errors: Array<{ type: string; message: string }> = [];
    for (const m of query.matchAll(/(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)) {
      const f = live.get(`${m[2]}/${m[3]}`);
      data[m[1]!] = f ? rawRepo(f) : null;
      if (!f) errors.push({ type: "NOT_FOUND", message: "not found" });
    }
    const asked = [...query.matchAll(/(i\d+): issue\(number: (\d+)\)/g)].filter((m) => !issues.unanswered?.includes(Number(m[2])));
    if (asked.length > 0) data["repository"] = Object.fromEntries(asked.map((m) => [m[1]!, { lastEditedAt: issues.edited?.[Number(m[2])] ?? null }]));
    return { data, errors };
  };
}

export type Call = { method: string; path: string; body: unknown };

/** A RestClient that answers from `handler` and records every call. */
export function fakeRest(handler: (c: Call) => unknown): { client: RestClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: RestClient = {
    async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
      const c = { method, path, body };
      calls.push(c);
      return (await handler(c)) as T;
    },
  };
  return { client, calls };
}

export type FakeIssue = {
  number: number;
  state: "open" | "closed";
  title: string;
  body: string | null;
  user: { login: string };
  labels: Array<{ name: string }>;
  created_at: string;
  closed_at: string | null;
  html_url: string;
  pull_request?: unknown;
};

export function issue(number: number, over: Partial<Omit<FakeIssue, "labels">> & { labels?: string[] } = {}): FakeIssue {
  const { labels = [], ...rest } = over;
  return {
    number,
    state: "open",
    title: `#${number}`,
    body: null,
    user: { login: "github-actions[bot]" },
    created_at: "2026-10-01T00:00:00Z",
    closed_at: null,
    html_url: `https://github.com/owner/repo/issues/${number}`,
    ...rest,
    labels: labels.map((name) => ({ name })),
  };
}

type LabelEvent = { event: "labeled"; label: { name: string }; actor: { login: string } };

/**
 * An in-memory issue tracker behind the REST paths IssueStore uses, so tests
 * see the same label, comment and close effects GitHub would produce. Issues
 * that start out approved were approved by the repo owner, unless `approvedBy`
 * names someone else for that number (null: no approval event at all); labels
 * added later are added by `actor`, the owner by default.
 */
export function fakeTracker(repo: string, initial: FakeIssue[], opts: { approvedBy?: Record<number, string | null>; actor?: string } = {}) {
  const owner = repo.split("/")[0]!;
  const issues = new Map(initial.map((i) => [i.number, i]));
  const comments: Array<{ number: number; body: string }> = [];
  const labeled = (name: string, login: string): LabelEvent => ({ event: "labeled", label: { name }, actor: { login } });
  const events = new Map<number, LabelEvent[]>();
  for (const i of initial) {
    const by = opts.approvedBy && i.number in opts.approvedBy ? opts.approvedBy[i.number] : owner;
    if (i.labels.some((l) => l.name === LABELS.approved) && by) events.set(i.number, [labeled(LABELS.approved, by)]);
  }
  let next = 900;
  const base = `/repos/${repo}`;
  const { client, calls } = fakeRest(({ method, path, body }) => {
    const url = new URL(path, "https://api.github.com");
    const p = url.pathname;
    const one = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)/.exec(p);
    const found = one ? issues.get(Number(one[1])) : undefined;
    if (one && !found) throw new GitHubError(`${method} ${path} → 404`, 404);
    if (method === "GET" && p === `${base}/issues`) {
      const label = url.searchParams.get("labels");
      const state = url.searchParams.get("state");
      const page = Number(url.searchParams.get("page") ?? "1");
      const hits = [...issues.values()].filter((i) => (!label || i.labels.some((l) => l.name === label)) && (state === "all" || i.state === state));
      return page === 1 ? hits : [];
    }
    if (method === "POST" && p === `${base}/issues`) {
      const b = body as { title: string; body: string; labels: string[] };
      const created = issue(next++, { title: b.title, body: b.body, labels: b.labels, user: { login: opts.actor ?? owner } });
      issues.set(created.number, created);
      return created;
    }
    if (method === "GET" && found && p.endsWith(`/issues/${found.number}`)) return found;
    if (method === "GET" && found && p.endsWith("/events")) return url.searchParams.get("page") === "1" ? (events.get(found.number) ?? []) : [];
    if (method === "POST" && found && p.endsWith("/labels")) {
      for (const name of (body as { labels: string[] }).labels) {
        if (!found.labels.some((l) => l.name === name)) found.labels.push({ name });
        events.set(found.number, [...(events.get(found.number) ?? []), labeled(name, opts.actor ?? owner)]);
      }
      return found.labels;
    }
    if (method === "DELETE" && found && p.includes("/labels/")) {
      const name = decodeURIComponent(p.split("/labels/")[1]!);
      if (!found.labels.some((l) => l.name === name)) throw new GitHubError("label not on issue", 404);
      found.labels = found.labels.filter((l) => l.name !== name);
      return undefined;
    }
    if (method === "POST" && found && p.endsWith("/comments")) {
      comments.push({ number: found.number, body: (body as { body: string }).body });
      return {};
    }
    if (method === "PATCH" && found) {
      found.state = "closed";
      found.closed_at = NOW.toISOString();
      return found;
    }
    if (method === "GET" && p === `${base}/labels`) return [];
    if (method === "POST" && p === `${base}/labels`) return {};
    throw new Error(`fake GitHub has no route for ${method} ${path}`);
  });
  const labelsOf = (n: number) => issues.get(n)?.labels.map((l) => l.name) ?? [];
  return { client, calls, issues, comments, labelsOf };
}
