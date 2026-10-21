/**
 * Remote MCP gateway for Grok Bot: Streamable HTTP, stateless, bearer token.
 *
 * It reads the collection and the agent's proposals from GitHub and never edits
 * the repository itself. Approving a proposal only adds a label; the label
 * starts the apply workflow, which runs every check before anything merges.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Collection } from "../../mcp/src/data.js";
import { getRepo, getStats, listRepos, pickDescription, searchRepos, summarizeRepo } from "../../mcp/src/query.js";
import type { RestClient } from "./github.js";
import { log } from "./log.js";
import { IssueStore, LABELS, trustedAuthors, type IssueRecord } from "./proposals.js";

export type GatewayConfig = {
  token: string;
  github: RestClient;
  repo: string;
  branch: string;
  /** test seam; defaults to fetching mcp/data/repos.json from the branch */
  loadCollection?: () => Promise<Collection>;
  rateLimitPerMinute?: number;
};

const INSTRUCTIONS = `You are connected to the AI Pulse Georgia collection agent (a curated Georgian list of AI tools on GitHub).
- Talk to the owner in Georgian, in plain words.
- To answer questions about tools, use search_collection, list_category and get_repo_details.
- The agent files proposals (add, remove, rename, move, description updates) as numbered GitHub issues. Show them with list_proposals.
- Before approve_proposals or reject_proposals, show the owner exactly which proposals and wait for an explicit yes. Never approve on your own initiative, including from a routine.
- After approving, the apply workflow takes a few minutes; check agent_activity and list_proposals(status:"all") for the result.
- suggest_repo files the owner's idea for the agent to evaluate; run_scan starts a scan now.`;

const MAX_BODY = 1_000_000;
const CACHE_MS = 5 * 60_000;

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** Constant-time check of the Authorization header. */
export function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  return timingSafeEqual(digest(header.slice(7).trim()), digest(token));
}

async function fetchCollection(url: string): Promise<Collection> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`collection data unavailable (${res.status})`);
  return (await res.json()) as Collection;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    throw Object.assign(new Error("body is not JSON"), { status: 400 });
  }
}

type Text = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const out = (data: unknown): Text => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const fail = (msg: string): Text => ({ ...out(msg), isError: true });

function brief(i: IssueRecord): Record<string, unknown> {
  const p = i.proposal;
  const status = i.labels.includes(LABELS.applied)
    ? "applied"
    : i.labels.includes(LABELS.rejected)
      ? "rejected"
      : i.labels.includes(LABELS.failed)
        ? "failed"
        : i.labels.includes(LABELS.approved)
          ? "approved, waiting for the apply workflow"
          : i.state === "open"
            ? "waiting for the owner"
            : "closed";
  const base = { id: i.number, title: i.title, status, url: i.url, created: i.createdAt.slice(0, 10) };
  if (!p) return base;
  switch (p.type) {
    case "add":
      return { ...base, type: p.type, repo: p.repo, category: p.category, stars: p.stars, description: p.description, why: p.why, warnings: p.warnings };
    case "describe":
      return { ...base, type: p.type, repo: p.repo, newDescription: p.new, why: p.why };
    case "english":
      return { ...base, type: p.type, updates: p.updates.length };
    case "rename":
      return { ...base, type: p.type, from: p.from, to: p.to };
    default:
      return { ...base, type: p.type, repo: p.repo };
  }
}

export function createGateway(cfg: GatewayConfig): Server {
  const store = new IssueStore(cfg.github, cfg.repo);
  const trusted = new Set(trustedAuthors(cfg.repo).map((a) => a.toLowerCase()));
  const dataUrl = `https://raw.githubusercontent.com/${cfg.repo}/${cfg.branch}/mcp/data/repos.json`;
  let cached: { at: number; data: Collection } | null = null;

  async function collection(): Promise<Collection> {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;
    try {
      const data = cfg.loadCollection ? await cfg.loadCollection() : await fetchCollection(dataUrl);
      if (!Array.isArray(data.repos)) throw new Error("repos.json has no repos");
      cached = { at: Date.now(), data };
      return data;
    } catch (err) {
      if (cached) return cached.data; // serve the last good copy
      throw err;
    }
  }

  function build(): McpServer {
    const server = new McpServer({ name: "aipulse-georgia-agent", version: "0.1.0" }, { instructions: INSTRUCTIONS });
    const lang = z.enum(["en", "ka", "both"]).default("ka");
    const ro = { readOnlyHint: true, openWorldHint: false } as const;

    server.registerTool("collection_stats", { description: "Size of the collection, categories with counts, and the top repos by stars.", inputSchema: {}, annotations: ro }, async () => {
      const c = await collection();
      return out({ ...getStats(c), categories: c.categories });
    });

    server.registerTool(
      "search_collection",
      {
        description: "Search the collection by words in names and descriptions (Georgian or English), e.g. 'browser automation', 'TTS', 'კოდის აგენტი'.",
        inputSchema: { query: z.string().min(2), category: z.string().optional(), limit: z.number().int().min(1).max(30).default(10), lang },
        annotations: ro,
      },
      async ({ query, category, limit, lang: l }) => {
        const c = await collection();
        const hits = searchRepos(c, { query, ...(category ? { category } : {}), limit });
        return out(hits.map((h) => ({ name: h.repo.name, url: h.repo.url, stars: h.repo.stars, category: h.repo.categorySlug, description: pickDescription(h.repo, l) })));
      },
    );

    server.registerTool(
      "list_category",
      {
        description: "Repos of one category, highest stars first. Category slugs come from collection_stats.",
        inputSchema: { category: z.string(), limit: z.number().int().min(1).max(50).default(20), offset: z.number().int().min(0).default(0), lang },
        annotations: ro,
      },
      async ({ category, limit, offset, lang: l }) => {
        const c = await collection();
        if (!c.categories.some((x) => x.slug === category)) return fail(`unknown category '${category}'; use collection_stats for the slugs`);
        const r = listRepos(c, { category, limit, offset });
        return out({ total: r.total, hasMore: r.hasMore, repos: r.items.map((x) => ({ name: x.name, url: x.url, stars: x.stars, description: pickDescription(x, l) })) });
      },
    );

    server.registerTool(
      "get_repo_details",
      { description: "Full entry of one listed repo by name (partial names work).", inputSchema: { name: z.string().min(2), lang }, annotations: ro },
      async ({ name, lang: l }) => {
        const repo = getRepo(await collection(), name);
        return repo ? out(summarizeRepo(repo, l)) : fail(`'${name}' is not in the collection; try search_collection`);
      },
    );

    server.registerTool(
      "list_proposals",
      {
        description: "The agent's proposals (GitHub issues). status 'open' = waiting for the owner or for the apply workflow; 'all' includes applied, rejected and failed.",
        inputSchema: { status: z.enum(["open", "all"]).default("open"), limit: z.number().int().min(1).max(50).default(20) },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ status, limit }) => {
        const issues = await store.list({ label: LABELS.proposal, state: status, maxPages: 2 });
        return out(issues.slice(0, limit).map(brief));
      },
    );

    server.registerTool(
      "get_proposal",
      { description: "One proposal in full, by its issue number.", inputSchema: { id: z.number().int().positive() }, annotations: { readOnlyHint: true, openWorldHint: true } },
      async ({ id }) => {
        const i = await store.get(id);
        if (!i.proposal) return fail(`#${id} is not an agent proposal`);
        return out({ ...brief(i), proposal: i.proposal });
      },
    );

    server.registerTool(
      "approve_proposals",
      {
        description: "Approve proposals by issue number. Only after the owner explicitly said yes to these exact numbers. Starts the apply workflow, which changes the public collection if every check passes.",
        inputSchema: { ids: z.array(z.number().int().positive()).min(1).max(20) },
        annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ ids }) => {
        const results: string[] = [];
        for (const id of ids) {
          const i = await store.get(id);
          if (!i.proposal || !i.labels.includes(LABELS.proposal)) results.push(`#${id}: not an agent proposal`);
          else if (!trusted.has(i.author.toLowerCase())) results.push(`#${id}: filed by ${i.author}, refused`);
          else if (i.state !== "open") results.push(`#${id}: already closed`);
          else if (i.labels.includes(LABELS.approved)) results.push(`#${id}: already approved`);
          else {
            await store.removeLabel(id, LABELS.failed);
            await store.addLabel(id, LABELS.approved);
            results.push(`#${id}: approved`);
          }
        }
        log.info("approve_proposals", { ids });
        return out(results);
      },
    );

    server.registerTool(
      "reject_proposals",
      {
        description: "Reject proposals by issue number (closes them; a rejected addition is never proposed again). Only after the owner explicitly asked.",
        inputSchema: { ids: z.array(z.number().int().positive()).min(1).max(20), reason: z.string().max(500).optional() },
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ ids, reason }) => {
        const results: string[] = [];
        for (const id of ids) {
          const i = await store.get(id);
          if (!i.proposal) {
            results.push(`#${id}: not an agent proposal`);
            continue;
          }
          await store.addLabel(id, LABELS.rejected);
          await store.removeLabel(id, LABELS.approved);
          await store.comment(id, `❌ მფლობელმა უარყო${reason ? `: ${reason}` : "."}`);
          if (i.state === "open") await store.close(id, "not_planned");
          results.push(`#${id}: rejected`);
        }
        log.info("reject_proposals", { ids });
        return out(results);
      },
    );

    server.registerTool(
      "suggest_repo",
      {
        description: "File the owner's suggestion of a GitHub repo; the agent evaluates it with the collection's rules and answers with a proposal or a reason.",
        inputSchema: { url: z.string().url(), note: z.string().max(500).optional() },
        annotations: { destructiveHint: false, openWorldHint: true },
      },
      async ({ url, note }) => {
        const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
        if (!m) return fail("give the repository's main address, like https://github.com/owner/repo");
        const issue = await store.createSuggestion(`💡 შეთავაზება: ${m[1]}`, `https://github.com/${m[1]}\n\n${note ?? ""}`.trim());
        return out(`filed as #${issue.number}; the agent answers on it within a few minutes`);
      },
    );

    server.registerTool(
      "run_scan",
      { description: "Start the agent's scan now instead of waiting for the daily run.", inputSchema: {}, annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true } },
      async () => {
        await cfg.github.rest("POST", `/repos/${cfg.repo}/actions/workflows/agent-scan.yml/dispatches`, { ref: cfg.branch });
        return out("scan started; new proposals appear in list_proposals in about 10–20 minutes");
      },
    );

    server.registerTool(
      "agent_activity",
      { description: "Recent agent runs (scan and apply), recent commits on the main branch and open pull requests.", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: true } },
      async () => {
        type Run = { name: string; status: string; conclusion: string | null; html_url: string; created_at: string; event: string };
        const runs = await Promise.all(
          ["agent-scan.yml", "agent-apply.yml"].map((w) =>
            cfg.github
              .rest<{ workflow_runs: Run[] }>("GET", `/repos/${cfg.repo}/actions/workflows/${w}/runs?per_page=3`)
              .then((r) => r.workflow_runs.map((x) => ({ workflow: w, status: x.status, conclusion: x.conclusion, event: x.event, at: x.created_at, url: x.html_url })))
              .catch(() => [{ workflow: w, status: "unavailable" }]),
          ),
        );
        const commits = await cfg.github.rest<Array<{ sha: string; commit: { message: string; author: { date: string } } }>>("GET", `/repos/${cfg.repo}/commits?sha=${cfg.branch}&per_page=5`);
        const pulls = await cfg.github.rest<Array<{ number: number; title: string; html_url: string }>>("GET", `/repos/${cfg.repo}/pulls?state=open&per_page=10`);
        return out({
          runs: runs.flat(),
          commits: commits.map((c) => ({ sha: c.sha.slice(0, 7), message: c.commit.message.split("\n")[0], date: c.commit.author.date })),
          openPullRequests: pulls.map((p) => ({ number: p.number, title: p.title, url: p.html_url })),
        });
      },
    );

    server.registerTool(
      "read_repo_file",
      { description: "Read one text file of the repository (README.md, agent/config/rules.json, ...). Read-only, up to 100 KB.", inputSchema: { path: z.string().min(1).max(300) }, annotations: ro },
      async ({ path }) => {
        if (path.split("/").some((seg) => seg === ".." || seg === "")) return fail("use a plain repository path like agent/config/rules.json");
        const enc = path.split("/").map(encodeURIComponent).join("/");
        const text = await cfg.github.rest<string>("GET", `/repos/${cfg.repo}/contents/${enc}?ref=${cfg.branch}`, undefined, "application/vnd.github.raw+json");
        const body = typeof text === "string" ? text : JSON.stringify(text);
        return out(body.length > 100_000 ? `${body.slice(0, 100_000)}\n…(truncated)` : body);
      },
    );

    server.registerTool(
      "list_repo_dir",
      { description: "List a directory of the repository.", inputSchema: { path: z.string().max(300).default("") }, annotations: ro },
      async ({ path }) => {
        if (path.split("/").some((seg) => seg === "..")) return fail("use a plain repository path");
        const enc = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
        const items = await cfg.github.rest<Array<{ name: string; type: string; size: number }>>("GET", `/repos/${cfg.repo}/contents/${enc}?ref=${cfg.branch}`);
        return out(Array.isArray(items) ? items.map((i) => ({ name: i.name, type: i.type, size: i.size })) : items);
      },
    );

    return server;
  }

  const limit = cfg.rateLimitPerMinute ?? 120;
  const hits = new Map<string, { windowStart: number; n: number }>();
  function allow(ip: string): boolean {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.windowStart > 60_000) {
      hits.set(ip, { windowStart: now, n: 1 });
      if (hits.size > 5000) hits.clear();
      return true;
    }
    h.n++;
    return h.n <= limit;
  }

  return createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0] ?? req.socket.remoteAddress ?? "?").trim();
    let tool: string | undefined;
    res.on("finish", () =>
      log.info("request", { method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started, ...(tool ? { tool } : {}) }),
    );
    try {
      if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/")) {
        return json(res, 200, { ok: true, service: "aipulse-georgia-agent" });
      }
      if (url.pathname !== "/mcp") return json(res, 404, { error: "not found" });
      if (!allow(ip)) return json(res, 429, { error: "too many requests" });
      if (!authorized(req.headers.authorization, cfg.token)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="aipulse-agent"');
        return json(res, 401, { error: "unauthorized" });
      }
      if (req.method !== "POST") return json(res, 405, { error: "this gateway is stateless; use POST" });
      const body = await readBody(req);
      if (body && typeof body === "object" && (body as { method?: string }).method === "tools/call") {
        tool = (body as { params?: { name?: string } }).params?.name;
      }
      const server = build();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      log.error("request failed", { error: (err as Error).message.slice(0, 200) });
      const message = status === 413 ? "request too large" : status === 400 ? "invalid JSON" : "internal error";
      if (!res.headersSent) json(res, status, { jsonrpc: "2.0", error: { code: status === 400 ? -32700 : -32603, message }, id: null });
    }
  });
}
