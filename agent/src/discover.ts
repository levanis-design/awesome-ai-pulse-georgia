/**
 * Where new repos come from: GitHub search by creation date and star bands,
 * plus the public trending pages. Every source reports whether it worked, so
 * a broken source shows up in the scan summary instead of as "nothing new".
 */
import type { Rules } from "./config.js";
import type { GitHub } from "./github.js";
import { log } from "./log.js";
import { DAY_MS } from "./rules.js";

export type SourceReport = {
  source: string;
  ok: boolean;
  found: number;
  error?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const day = (d: Date) => d.toISOString().slice(0, 10);

/** Search queries for this run: new repos by topic and keyword, plus older big misses still being pushed. */
export function searchQueries(rules: Rules, now: Date): string[] {
  const t = rules.thresholds;
  const since = day(new Date(now.getTime() - t.discoverWindowDays * DAY_MS));
  const fresh = `created:>=${since} stars:>=${t.minStarsNew} archived:false fork:false`;
  const old = `stars:>=${t.minStarsOld} pushed:>=${since} archived:false fork:false`;
  return [
    ...rules.discoverTopics.map((topic) => `topic:${topic} ${fresh}`),
    ...rules.discoverKeywords.map((kw) => `${kw} in:name,description ${fresh}`),
    ...rules.bigMissTopics.map((topic) => `topic:${topic} ${old}`),
  ];
}

export async function searchCandidates(
  gh: GitHub,
  rules: Rules,
  now: Date,
): Promise<{ repos: Set<string>; report: SourceReport }> {
  const repos = new Set<string>();
  const queries = searchQueries(rules, now);
  let failures = 0;
  let lastError = "";
  for (const q of queries) {
    try {
      for (const item of await gh.searchRepos(q, 50)) {
        if (!item.archived && !item.fork) repos.add(item.full_name);
      }
    } catch (err) {
      failures++;
      lastError = (err as Error).message;
      log.warn("search query failed", { q, error: lastError.slice(0, 160) });
    }
    await sleep(2200); // search API: 30 requests a minute with a token
  }
  const ok = failures < queries.length;
  return {
    repos,
    report: {
      source: "github-search",
      ok,
      found: repos.size,
      ...(failures
        ? {
            error: `${failures}/${queries.length} queries failed: ${lastError.slice(0, 120)}`,
          }
        : {}),
    },
  };
}

/** owner/repo paths from a github.com/trending page. */
export function parseTrending(html: string): string[] {
  const out: string[] = [];
  const re =
    /<article class="Box-row"[\s\S]*?<h2[^>]*>[\s\S]*?href="\/([\w.-]+\/[\w.-]+)"/g;
  for (const m of html.matchAll(re)) out.push(m[1]!);
  return [...new Set(out)];
}

export async function trendingCandidates(
  gh: GitHub,
): Promise<{ repos: Set<string>; report: SourceReport }> {
  const repos = new Set<string>();
  const pages = [
    "",
    "python",
    "typescript",
    "javascript",
    "rust",
    "go",
  ].flatMap((lang) =>
    ["weekly", "monthly"].map(
      (since) =>
        `https://github.com/trending${lang ? `/${lang}` : ""}?since=${since}`,
    ),
  );
  let worked = 0;
  let lastError = "";
  for (const url of pages) {
    try {
      const found = parseTrending(await gh.page(url));
      if (found.length > 0) worked++;
      found.forEach((r) => repos.add(r));
    } catch (err) {
      lastError = (err as Error).message;
      log.warn("trending page failed", { url, error: lastError.slice(0, 120) });
    }
    await sleep(800);
  }
  return {
    repos,
    report: {
      source: "github-trending",
      ok: worked > 0,
      found: repos.size,
      ...(worked === 0
        ? { error: lastError || "no repos parsed from any trending page" }
        : {}),
    },
  };
}
