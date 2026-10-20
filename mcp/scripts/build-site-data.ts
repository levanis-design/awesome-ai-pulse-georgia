/**
 * build-site-data.ts — generate docs/data.js for the landing page from the
 * canonical mcp/data/repos.json. The site loads this via a <script> tag, so the
 * data stays a single source of truth and the GitHub Pages site auto-refreshes
 * whenever repos.json is rebuilt (build:data / refresh:stars).
 *
 * Output: docs/data.js → window.AIPULSE = { generated, stats, categories, repos }
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const SRC = resolve(ROOT, "mcp", "data", "repos.json");
const OUT = resolve(ROOT, "docs", "data.js");

/** Brand accent per category (kept in sync with the README category set). */
const CATEGORY_COLOR: Record<string, string> = {
  coding: "#60A5FA",
  plugins: "#34D399",
  design: "#FB923C",
  mcp: "#A78BFA",
  scraping: "#FBBF24",
  frameworks: "#F87171",
  workflow: "#22D3EE",
  business: "#F472B6",
  finance: "#EAB308",
  memory: "#C084FC",
  codeintel: "#6366F1",
  tokens: "#4ADE80",
  infra: "#2DD4BF",
  orchestration: "#38BDF8",
  agentinfra: "#A8A29E",
  security: "#F43F5E",
  assistants: "#E879F9",
  research: "#FDE047",
  media: "#84CC16",
  voice: "#FCA5A5",
  resources: "#94A3B8",
};

type SrcRepo = {
  name: string;
  url: string;
  stars: string;
  starsNumeric: number | null;
  description: string;
  categorySlug: string;
  categoryEmoji: string;
};
type SrcCat = {
  slug: string;
  emoji: string;
  georgian: string;
  english: string;
  count: number;
};

/** Full description, whitespace-normalized to a single line for the card. */
function cardText(desc: string): string {
  return desc.replace(/\s+/g, " ").trim();
}

const src = JSON.parse(readFileSync(SRC, "utf-8")) as {
  generated: string;
  categories: SrcCat[];
  repos: SrcRepo[];
};

const repos = src.repos.map((r) => ({
  name: r.name,
  url: r.url,
  stars: r.stars,
  s: r.starsNumeric ?? 0,
  cat: r.categorySlug,
  d: cardText(r.description),
}));

const categories = src.categories.map((c) => ({
  slug: c.slug,
  emoji: c.emoji,
  georgian: c.georgian,
  english: c.english,
  color: CATEGORY_COLOR[c.slug] ?? "#94A3B8",
  count: c.count,
}));

const totalStars = repos.reduce((sum, r) => sum + r.s, 0);

const payload = {
  generated: src.generated,
  stats: { repos: repos.length, categories: categories.length, totalStars },
  categories,
  repos,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  "window.AIPULSE = " + JSON.stringify(payload) + ";\n",
  "utf-8",
);
// eslint-disable-next-line no-console
console.log(
  `Wrote docs/data.js — ${repos.length} repos, ${categories.length} categories, ${totalStars.toLocaleString("en-US")} total stars.`,
);
