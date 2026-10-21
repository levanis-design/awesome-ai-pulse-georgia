/**
 * The repo and category counts live in hand-written text outside the data
 * files too. Every spot is listed here with how many times it must match, so
 * a missed or drifted spot stops the run instead of shipping a stale number.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Kind = "repos" | "categories";

type Spot = {
  file: string;
  pattern: RegExp;
  /** which capture groups hold which count, in order */
  groups: Kind[];
  expected: number;
};

export const SPOTS: Spot[] = [
  { file: "README.md", pattern: /repos-(\d+)-00D0FF/g, groups: ["repos"], expected: 1 },
  { file: "README.md", pattern: /categories-(\d+)-/g, groups: ["categories"], expected: 1 },
  { file: "README.md", pattern: /(\d+) რეპოს ეძებ/g, groups: ["repos"], expected: 1 },
  { file: "README.md", pattern: /query (\d+) curated AI repos/g, groups: ["repos"], expected: 1 },
  { file: "assets/banner.svg", pattern: /fill="#00D0FF" font-weight="700" font-size="20">(\d+)</g, groups: ["repos"], expected: 1 },
  { file: "assets/banner.svg", pattern: /fill="#A949DA" font-weight="700" font-size="20">(\d+)</g, groups: ["categories"], expected: 1 },
  { file: "docs/index.html", pattern: /(\d+) ხელით შერჩეული/g, groups: ["repos"], expected: 3 },
  { file: "docs/index.html", pattern: /რეპოზიტორია (\d+) კატეგორიაში/g, groups: ["categories"], expected: 2 },
  { file: "docs/index.html", pattern: /(\d+) რეპო (\d+) კატეგორიაში/g, groups: ["repos", "categories"], expected: 1 },
  { file: "docs/index.html", pattern: /<span class="eyebrow">(\d+) კატეგორია<\/span>/g, groups: ["categories"], expected: 1 },
  { file: "site/index.html", pattern: /(\d+) ხელით შერჩეული/g, groups: ["repos"], expected: 1 },
  { file: "mcp/README.md", pattern: /\((\d+) AI repos across (\d+) categories\)/g, groups: ["repos", "categories"], expected: 1 },
  { file: "mcp/src/index.ts", pattern: /collection \((\d+) repos(?:\r?\n) \* across (\d+) categories\)/g, groups: ["repos", "categories"], expected: 1 },
  { file: "mcp/package.json", pattern: /query (\d+) curated/g, groups: ["repos"], expected: 1 },
  { file: "mcp/smithery.yaml", pattern: /Query (\d+) curated AI repos in (\d+) categories/g, groups: ["repos", "categories"], expected: 1 },
];

export type Counts = { repos: number; categories: number };

export class CountsError extends Error {
  override name = "CountsError";
}

export type UpdateOptions = {
  /** write the files (default) or only return their new contents */
  write?: boolean;
  /** contents to start from instead of the file on disk, e.g. a README that is not written yet */
  seed?: ReadonlyMap<string, string>;
};

/**
 * Rewrite every count spot from `from` to `to` and bump the README badge
 * cache-buster. Returns the new file contents; writes them unless `write` is false.
 * Nothing is written when any spot is missing or already disagrees with `from`.
 */
export function updateCounts(root: string, from: Counts, to: Counts, opts: UpdateOptions = {}): Map<string, string> {
  const files = new Map<string, string>(opts.seed ?? []);
  const read = (f: string) => files.get(f) ?? readFileSync(resolve(root, f), "utf-8");
  const problems: string[] = [];
  for (const spot of SPOTS) {
    const text = read(spot.file);
    const matches = [...text.matchAll(new RegExp(spot.pattern.source, "gd"))];
    if (matches.length !== spot.expected) {
      problems.push(`${spot.file}: ${spot.pattern.source} matched ${matches.length}×, expected ${spot.expected}×`);
      continue;
    }
    // splice by group offsets, last first, so earlier offsets stay valid and a
    // number inside another number (21 in 212) can never be hit by mistake
    const edits: Array<[number, number, string]> = [];
    for (const m of matches) {
      spot.groups.forEach((kind, g) => {
        const seen = Number(m[g + 1]);
        if (seen !== from[kind]) problems.push(`${spot.file}: says ${seen} ${kind}, the README says ${from[kind]}`);
        const [s, e] = m.indices![g + 1]!;
        edits.push([s, e, String(to[kind])]);
      });
    }
    let next = text;
    for (const [s, e, v] of edits.sort((a, b) => b[0] - a[0])) next = next.slice(0, s) + v + next.slice(e);
    files.set(spot.file, next);
  }
  if (problems.length > 0) throw new CountsError(problems.join("\n"));
  // shields.io caches by URL: bump v= so the new badge is fetched
  files.set(
    "README.md",
    read("README.md").replace(/(repos-\d+-00D0FF\?[^"]*?v=)(\d+)/, (_w, pre: string, v: string) => `${pre}${Number(v) + 1}`),
  );
  if (opts.write ?? true) for (const [f, text] of files) writeFileSync(resolve(root, f), text, "utf-8");
  return files;
}

/** Throws a CountsError naming every spot that is missing or does not say `counts`; writes nothing. */
export function checkCounts(root: string, counts: Counts): void {
  updateCounts(root, counts, counts, { write: false });
}

/** Read the current counts straight from the README badges. */
export function readBadgeCounts(readme: string): Counts {
  const r = /repos-(\d+)-00D0FF/.exec(readme);
  const c = /categories-(\d+)-/.exec(readme);
  if (!r || !c) throw new CountsError("README badges not found");
  return { repos: Number(r[1]), categories: Number(c[1]) };
}
