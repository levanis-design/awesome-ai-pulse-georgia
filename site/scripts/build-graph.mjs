/**
 * build-graph.mjs — generate site/public/data/graph.json (the single source of
 * truth for the constellation site) from the README-parsed mcp/data/repos.json.
 *
 * Nodes  = every linked repo + a central hub node "claude-code".
 * Edges  = (1) cluster: each repo → its category's top-starred anchor;
 *          (2) hub: claude-code → every plugin/skill/MCP and Claude-Code-related repo;
 *          (3) cross: same-tool families + curated concept relationships.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const SRC = resolve(ROOT, "mcp", "data", "repos.json");
const OUT = resolve(__dirname, "..", "public", "data", "graph.json");

/** Refined, desaturated jewel tones — one per category. Restrained, not neon. */
const CATEGORY_COLOR = {
  coding: "#5BB9CC",
  plugins: "#9BC084",
  design: "#CF8FAE",
  mcp: "#8C9AC6",
  scraping: "#CDAE78",
  frameworks: "#A284BE",
  workflow: "#73BCAE",
  business: "#C9977A",
  finance: "#C2B079",
  memory: "#6FB6A8",
  codeintel: "#9F90C2",
  tokens: "#6FAE84",
  infra: "#7EB6C2",
  media: "#C386A2",
  voice: "#D9A07F",
  resources: "#97A0AE",
  orchestration: "#6FA3CF",
  agentinfra: "#8FA9B8",
  security: "#C98282",
  assistants: "#C2A0C9",
  research: "#B9B37A",
};

const HUB_ID = "claude-code";
const HUB = {
  id: HUB_ID,
  label: "Claude Code",
  category: "coding",
  url: "https://github.com/anthropics/claude-code",
  desc: "Anthropic-ის აგენტური coding ხელსაწყო, რომელიც პირდაპირ ტერმინალში ცხოვრობს, შენს კოდბაზას ესმის და რუტინულ ამოცანებს თავად ასრულებს. ამ მთელი კოლექციის გრავიტაციული ცენტრი — პლაგინების, skill-ებისა და MCP სერვერების უმეტესობა სწორედ Claude Code-ის ეკოსისტემაშია.",
  stars: 132812,
  isHub: true,
};

const data = JSON.parse(readFileSync(SRC, "utf-8"));

/** repo slug from the GitHub url (unique, used for ?node= deep links). */
function slugOf(url, used) {
  let base = "repo";
  const m = url.match(/github\.com\/[^/]+\/([^/?#]+)/i) || url.match(/gist\.github\.com\/[^/]+\/([0-9a-f]+)/i);
  if (m) base = m[1].replace(/\.git$/, "");
  let s = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
  let id = s, i = 2;
  while (used.has(id)) id = `${s}-${i++}`;
  used.add(id);
  return id;
}

const used = new Set([HUB_ID]);
const nodes = data.repos.map((r) => ({
  id: slugOf(r.url, used),
  label: r.name,
  category: r.categorySlug,
  url: r.url,
  desc: r.description,
  descEn: r.descriptionEn || null,
  stars: r.starsNumeric ?? 0,
}));
nodes.push(HUB);

const byId = new Map(nodes.map((n) => [n.id, n]));
const links = [];
const linkSet = new Set();
function addLink(a, b, type) {
  if (a === b || !byId.has(a) || !byId.has(b)) return;
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  if (linkSet.has(key)) return;
  linkSet.add(key);
  links.push({ source: a, target: b, type });
}

// (1) CLUSTER — each repo links to its category's top-starred anchor.
const anchors = {};
for (const cat of data.categories) {
  const members = nodes.filter((n) => !n.isHub && n.category === cat.slug);
  if (!members.length) continue;
  const anchor = members.slice().sort((a, b) => b.stars - a.stars)[0];
  anchors[cat.slug] = anchor.id;
  for (const m of members) if (m.id !== anchor.id) addLink(m.id, anchor.id, "cluster");
}

// (2) HUB — Claude Code connects to every plugin/skill/MCP + repos that name it.
const HUB_CATS = new Set(["plugins", "mcp"]);
const mentionsCC = (n) =>
  /claude[\s-]?code/i.test(n.desc || "") || /claude[\s-]?code/i.test(n.descEn || "");
for (const n of nodes) {
  if (n.isHub) continue;
  if (HUB_CATS.has(n.category) || mentionsCC(n)) addLink(HUB_ID, n.id, "hub");
}
// keep the hub anchored to each category cluster via its anchor too
for (const slug of Object.keys(anchors)) addLink(HUB_ID, anchors[slug], "hub");

// (3) CROSS — same-tool families (shared meaningful slug token).
const STOP = new Set([
  "mcp", "cli", "ai", "api", "server", "skill", "skills", "claude", "code", "agent", "agents",
  "the", "for", "app", "js", "ts", "py", "tool", "tools", "plugin", "plugins", "open", "awesome",
  "gpt", "llm", "kit", "ui", "dev", "go", "rs", "core", "lib", "studio", "pro", "max", "x",
]);
const tokenMap = new Map();
for (const n of nodes) {
  if (n.isHub) continue;
  const toks = new Set(n.id.split("-").filter((t) => t.length >= 3 && !STOP.has(t)));
  for (const t of toks) {
    if (!tokenMap.has(t)) tokenMap.set(t, []);
    tokenMap.get(t).push(n.id);
  }
}
for (const [, ids] of tokenMap) {
  if (ids.length >= 2 && ids.length <= 5) {
    for (let i = 1; i < ids.length; i++) addLink(ids[0], ids[i], "cross");
  }
}

// curated concept relationships — memory / knowledge-graph / RAG mesh.
const conceptGroups = [
  { test: (n) => n.category === "memory" || /\b(rag|vector|knowledge|memory|mem)\b/i.test(n.label) },
];
for (const g of conceptGroups) {
  const ids = nodes.filter((n) => !n.isHub && g.test(n)).sort((a, b) => byId.get(b.id).stars - byId.get(a.id).stars).map((n) => n.id);
  for (let i = 1; i < ids.length; i++) addLink(ids[0], ids[i], "cross");
}

const categories = data.categories.map((c) => ({
  id: c.slug,
  label: c.georgian,
  color: CATEGORY_COLOR[c.slug] || "#AEB8CC",
}));

const out = {
  generated: data.generated,
  categories,
  nodes,
  links,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n", "utf-8");

const hubDegree = links.filter((l) => l.source === HUB_ID || l.target === HUB_ID).length;
const byType = links.reduce((a, l) => ((a[l.type] = (a[l.type] || 0) + 1), a), {});
console.log(`graph.json → ${nodes.length} nodes, ${links.length} links ${JSON.stringify(byType)}`);
console.log(`Claude Code hub degree: ${hubDegree}`);
