/**
 * The gate the apply workflow runs after rebuilding the derived data. Every
 * check is a plain comparison between files, so a pass or a fail needs no
 * judgement: the README, its badges, every count spot and the generated data
 * must all tell the same story before anything is pushed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CategoryMeta } from "./config.js";
import { checkCounts, readBadgeCounts } from "./counts.js";
import { allPaths, parseReadme, serializeReadme, totals, validateRow, type ReadmeDoc } from "./readme.js";

const read = (root: string, ...parts: string[]) => readFileSync(resolve(root, ...parts), "utf-8");

/** Problems found, or [] when the tree is consistent. */
export function verifyTree(root: string, categories: CategoryMeta[]): string[] {
  const text = read(root, "README.md");
  let doc: ReadmeDoc;
  try {
    doc = parseReadme(text, categories);
  } catch (err) {
    return [`README: ${(err as Error).message}`];
  }
  const problems: string[] = [];
  if (serializeReadme(doc) !== text) problems.push("README does not survive parse → serialize unchanged");

  const rows = totals(doc);
  try {
    const badge = readBadgeCounts(text);
    if (badge.repos !== rows.repos || badge.categories !== rows.categories) {
      problems.push(`README has ${rows.repos} rows in ${rows.categories} sections, its badges say ${badge.repos}/${badge.categories}`);
    }
    checkCounts(root, badge);
  } catch (err) {
    problems.push(...(err as Error).message.split("\n"));
  }

  for (const s of doc.sections) for (const r of s.rows) for (const e of validateRow(r)) problems.push(`${s.slug} / ${r.name}: ${e}`);
  const seen = new Set<string>();
  for (const p of allPaths(doc)) {
    if (seen.has(p.toLowerCase())) problems.push(`listed twice: ${p}`);
    seen.add(p.toLowerCase());
  }

  const data = JSON.parse(read(root, "mcp", "data", "repos.json")) as { totalRepos: number; repos: unknown[]; categories: unknown[] };
  if (data.repos.length !== rows.repos || data.totalRepos !== rows.repos || data.categories.length !== rows.categories) {
    problems.push(`mcp/data/repos.json has ${data.repos.length} repos (totalRepos ${data.totalRepos}) in ${data.categories.length} categories, the README ${rows.repos}/${rows.categories}`);
  }
  const site = /"stats":\{"repos":(\d+),"categories":(\d+)/.exec(read(root, "docs", "data.js"));
  if (!site || Number(site[1]) !== rows.repos || Number(site[2]) !== rows.categories) {
    problems.push(`docs/data.js says ${site ? `${site[1]}/${site[2]}` : "nothing readable"}, the README ${rows.repos}/${rows.categories}`);
  }
  return problems;
}
