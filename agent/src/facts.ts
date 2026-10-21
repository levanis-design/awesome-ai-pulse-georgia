/**
 * Live GitHub facts for many repos at once (GraphQL, 40 per request).
 * A renamed repo comes back under its new nameWithOwner; a deleted one as null.
 */
import type { GitHub } from "./github.js";
import { log } from "./log.js";

export type RepoFacts = {
  nameWithOwner: string;
  isArchived: boolean;
  isFork: boolean;
  isDisabled: boolean;
  stars: number;
  forks: number;
  watchers: number;
  commits: number | null;
  pushedAt: string;
  createdAt: string;
  description: string | null;
  license: string | null;
  language: string | null;
  topics: string[];
  homepage: string | null;
};

type RawRepo = {
  nameWithOwner: string;
  isArchived: boolean;
  isFork: boolean;
  isDisabled: boolean;
  stargazerCount: number;
  forkCount: number;
  watchers: { totalCount: number };
  pushedAt: string;
  createdAt: string;
  description: string | null;
  homepageUrl: string | null;
  licenseInfo: { spdxId: string | null } | null;
  primaryLanguage: { name: string } | null;
  repositoryTopics: { nodes: Array<{ topic: { name: string } }> };
  defaultBranchRef: {
    target: { history?: { totalCount: number } } | null;
  } | null;
};

const FIELDS = `nameWithOwner isArchived isFork isDisabled stargazerCount forkCount
  watchers { totalCount } pushedAt createdAt description homepageUrl
  licenseInfo { spdxId } primaryLanguage { name }
  repositoryTopics(first: 12) { nodes { topic { name } } }
  defaultBranchRef { target { ... on Commit { history { totalCount } } } }`;

const SAFE = /^[\w.-]+$/;
const BATCH = 40;

function toFacts(r: RawRepo): RepoFacts {
  return {
    nameWithOwner: r.nameWithOwner,
    isArchived: r.isArchived,
    isFork: r.isFork,
    isDisabled: r.isDisabled,
    stars: r.stargazerCount,
    forks: r.forkCount,
    watchers: r.watchers.totalCount,
    commits: r.defaultBranchRef?.target?.history?.totalCount ?? null,
    pushedAt: r.pushedAt,
    createdAt: r.createdAt,
    description: r.description,
    license: r.licenseInfo?.spdxId ?? null,
    language: r.primaryLanguage?.name ?? null,
    topics: r.repositoryTopics.nodes.map((n) => n.topic.name),
    homepage: r.homepageUrl,
  };
}

/**
 * Facts keyed by the path you asked for (lower-cased). Value null = the repo
 * does not exist any more (or was never public).
 */
export async function fetchFacts(
  gh: GitHub,
  paths: string[],
): Promise<Map<string, RepoFacts | null>> {
  const out = new Map<string, RepoFacts | null>();
  const unique = [...new Set(paths.map((p) => p.toLowerCase()))];
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    const aliases: string[] = [];
    chunk.forEach((p, j) => {
      const [owner, name] = p.split("/");
      if (!owner || !name || !SAFE.test(owner) || !SAFE.test(name)) {
        out.set(p, null);
        return;
      }
      aliases.push(
        `r${j}: repository(owner: "${owner}", name: "${name}") { ${FIELDS} }`,
      );
    });
    if (aliases.length === 0) continue;
    const { data, errors } = await gh.graphqlPartial<
      Record<string, RawRepo | null>
    >(`query { ${aliases.join("\n")} }`);
    // Only NOT_FOUND may null out an alias: any other error (rate limit,
    // permissions, timeout) would otherwise read as "this repo was deleted".
    const hardErrors = errors.filter((e) => e.type !== "NOT_FOUND");
    if (data === null || hardErrors.length > 0) {
      throw new Error(
        `GitHub GraphQL failed: ${hardErrors.map((e) => e.message).join("; ") || "no data returned"}`,
      );
    }
    const missing = errors.length;
    if (missing > 0) log.info("repos not found", { count: missing });
    chunk.forEach((p, j) => {
      if (out.has(p)) return;
      const raw = data?.[`r${j}`] ?? null;
      out.set(p, raw ? toFacts(raw) : null);
    });
  }
  return out;
}
