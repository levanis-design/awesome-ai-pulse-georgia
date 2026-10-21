/**
 * Loads agent/config/rules.json (the owner's curation rules) and the category
 * list. Fails fast with a readable message when either is malformed.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
/** agent/src → repository root. */
export const REPO_ROOT = resolve(here, "..", "..");

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
}

const RulesSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  thresholds: z.object({
    minStarsNew: z.number().int().positive(),
    minStarsOld: z.number().int().positive(),
    discoverWindowDays: z.number().int().positive(),
    floorIndependent: z.number().int().positive(),
    floorSlack: z.number().positive().max(1),
    minForkRatio: z.number().nonnegative(),
    minCommits: z.number().int().nonnegative(),
    staleMonths: z.number().int().positive(),
    maxNewPerScan: z.number().int().nonnegative(),
    maxDescriptionReviewsPerScan: z.number().int().nonnegative(),
  }),
  vendorOwners: z.array(z.string()),
  discoverTopics: z.array(z.string()),
  discoverKeywords: z.array(z.string()),
  bigMissTopics: z.array(z.string()),
  exclude: z.object({
    repos: z.record(z.string()),
    // a pattern that does not compile would otherwise stop the scan halfway through
    namePatterns: z.array(z.object({ pattern: z.string().refine(compiles, "not a valid regular expression"), reason: z.string() })),
  }),
});

export type Rules = z.infer<typeof RulesSchema>;

export function loadRules(path = resolve(REPO_ROOT, "agent", "config", "rules.json")): Rules {
  const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
  const parsed = RulesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`agent/config/rules.json is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

export type CategoryMeta = { slug: string; emoji: string; georgian: string; english: string };

/** The categories as the last data build saw them (mcp/data/repos.json). */
export function loadCategories(root = REPO_ROOT): CategoryMeta[] {
  const data = JSON.parse(readFileSync(resolve(root, "mcp", "data", "repos.json"), "utf-8")) as {
    categories: CategoryMeta[];
  };
  if (!Array.isArray(data.categories) || data.categories.length === 0) {
    throw new Error("mcp/data/repos.json has no categories — run `npm run build:data` in mcp/ first");
  }
  return data.categories.map(({ slug, emoji, georgian, english }) => ({ slug, emoji, georgian, english }));
}
