import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Collection } from "../../mcp/src/data.js";
import { REPO_ROOT } from "../src/config.js";
import { authorized, createGateway } from "../src/gateway.js";
import { issueBody, LABELS } from "../src/proposals.js";
import { CATS, DESC_OK, fakeTracker, issue } from "./helpers.js";

const SECRET = randomBytes(24).toString("hex"); // generated per run, never a literal
const REPO = "owner/repo";
const collection = JSON.parse(readFileSync(resolve(REPO_ROOT, "mcp/data/repos.json"), "utf-8")) as Collection;
const proposal = issueBody({ type: "add", repo: "acme/voice-kit", name: "Voice Kit", category: "voice", description: DESC_OK, stars: 9, why: "x", warnings: [], evidence: {} }, CATS);
const tracker = fakeTracker(REPO, [
  issue(1, { body: proposal, labels: [LABELS.proposal] }),
  issue(2, { body: proposal, labels: [LABELS.proposal], user: { login: "mallory" } }),
  issue(3, { body: proposal, labels: [LABELS.proposal, LABELS.applied], state: "closed" }),
  issue(4, { body: "a normal issue", user: { login: "owner" } }),
  issue(5, { body: proposal, labels: [LABELS.proposal, LABELS.failed] }),
]);
const extra: Array<{ method: string; path: string; body: unknown }> = [];
const github = {
  async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (path.includes("/contents/") || path.includes("/actions/")) {
      extra.push({ method, path, body });
      return (path.includes("/contents/") ? "file text" : undefined) as T;
    }
    return tracker.client.rest<T>(method, path, body);
  },
};

const server = createGateway({ token: SECRET, github, repo: REPO, branch: "main", loadCollection: async () => collection, rateLimitPerMinute: 10_000 });
let base = "";
let client: Client;
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${SECRET}` } } }));
});
after(async () => {
  await client.close();
  await new Promise<void>((r) => server.close(() => r()));
});

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { text: r.content.map((c) => c.text ?? "").join(""), isError: r.isError === true };
}
const post = (headers: Record<string, string>, body = "{}") => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body });

test("the token check is exact", () => {
  assert.ok(authorized(`Bearer ${SECRET}`, SECRET));
  assert.ok(!authorized(undefined, SECRET));
  assert.ok(!authorized(SECRET, SECRET));
  assert.ok(!authorized(`Bearer ${SECRET}x`, SECRET));
  assert.ok(!authorized(`Bearer ${SECRET.slice(0, -1)}`, SECRET));
});

test("health is public; everything under /mcp needs the token", async () => {
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "aipulse-georgia-agent" });
  const anonymous = await post({});
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate") ?? "", /^Bearer/);
  assert.equal((await post({ authorization: "Bearer wrong" })).status, 401);
  assert.equal((await fetch(`${base}/other`)).status, 404);
});

test("with the token: GET is refused (stateless), bad JSON and huge bodies get JSON-RPC errors", async () => {
  const auth = { authorization: `Bearer ${SECRET}` };
  assert.equal((await fetch(`${base}/mcp`, { headers: auth })).status, 405);
  const bad = await post(auth, "{not json");
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: { code: number } }).error.code, -32700);
  // the server stops reading at 1 MB; depending on timing the client sees the 413 or a closed connection
  const huge = await post(auth, JSON.stringify({ pad: "x".repeat(1_100_000) })).then(
    (r) => r.status,
    () => "connection closed",
  );
  assert.ok(huge === 413 || huge === "connection closed", String(huge));
});

test("an MCP client sees all thirteen tools, with honest hints", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 13);
  const hint = (n: string) => tools.find((t) => t.name === n)?.annotations;
  assert.equal(hint("approve_proposals")?.destructiveHint, true);
  for (const n of ["collection_stats", "search_collection", "list_category", "get_repo_details", "list_proposals", "get_proposal", "agent_activity", "read_repo_file", "list_repo_dir"]) {
    assert.equal(hint(n)?.readOnlyHint, true, n);
  }
});

test("the server tells the model to speak Georgian and never approve on its own", () => {
  const text = client.getInstructions() ?? "";
  assert.match(text, /Georgian/);
  assert.match(text, /Never approve on your own initiative/);
});

test("collection answers come from the data file, in Georgian by default", async () => {
  const stats = JSON.parse((await call("collection_stats")).text) as { totalRepos: number; categories: unknown[] };
  assert.equal(stats.totalRepos, collection.repos.length);
  assert.equal(stats.categories.length, collection.categories.length);
  const hits = JSON.parse((await call("search_collection", { query: "voice", limit: 5 })).text) as Array<{ category: string; description: string }>;
  assert.ok(hits.length > 0);
  assert.match(hits[0]!.description, /[ა-ჰ]/);
  assert.ok((await call("list_category", { category: "nope" })).isError);
  assert.ok((await call("get_repo_details", { name: "zz-not-a-repo-zz" })).isError);
});

test("approval adds the label only for open proposals the agent or the owner filed", async () => {
  const { text } = await call("approve_proposals", { ids: [1, 2, 3, 4, 5] });
  assert.deepEqual(JSON.parse(text), ["#1: approved", "#2: filed by mallory, refused", "#3: already closed", "#4: not an agent proposal", "#5: approved"]);
  assert.ok(tracker.labelsOf(1).includes(LABELS.approved));
  assert.ok(!tracker.labelsOf(2).includes(LABELS.approved));
  assert.deepEqual(tracker.labelsOf(5).sort(), [LABELS.approved, LABELS.proposal].sort()); // a retry clears the old failure
  assert.deepEqual(JSON.parse((await call("approve_proposals", { ids: [1] })).text), ["#1: already approved"]);
});

test("rejection closes the issue, removes any approval and says why", async () => {
  const { text } = await call("reject_proposals", { ids: [1], reason: "არ მინდა" });
  assert.deepEqual(JSON.parse(text), ["#1: rejected"]);
  assert.deepEqual(tracker.labelsOf(1).sort(), [LABELS.proposal, LABELS.rejected].sort());
  assert.equal(tracker.issues.get(1)?.state, "closed");
  assert.ok(tracker.comments.some((c) => c.number === 1 && c.body.includes("არ მინდა")));
});

test("suggestions take only a repository's main address", async () => {
  const ok = await call("suggest_repo", { url: "https://github.com/acme/new-tool", note: "ხმისთვის" });
  assert.match(ok.text, /filed as #900/);
  assert.deepEqual(tracker.labelsOf(900), [LABELS.suggestion]);
  assert.ok((await call("suggest_repo", { url: "https://example.com/acme/new-tool" })).isError);
  assert.ok((await call("suggest_repo", { url: "https://github.com/acme/new-tool/issues/1" })).isError);
});

test("file reading stays inside the repository", async () => {
  assert.ok((await call("read_repo_file", { path: "../other/secret" })).isError);
  assert.ok((await call("read_repo_file", { path: "agent//rules.json" })).isError);
  assert.equal((await call("read_repo_file", { path: "agent/config/rules.json" })).text, "file text");
  assert.equal(extra.at(-1)?.path, `/repos/${REPO}/contents/agent/config/rules.json?ref=main`);
  await call("read_repo_file", { path: "docs/a b#c?.md" });
  assert.equal(extra.at(-1)?.path, `/repos/${REPO}/contents/docs/a%20b%23c%3F.md?ref=main`);
});

test("run_scan starts the scan workflow on the branch", async () => {
  await call("run_scan");
  assert.deepEqual(extra.at(-1), { method: "POST", path: `/repos/${REPO}/actions/workflows/agent-scan.yml/dispatches`, body: { ref: "main" } });
});

test("a client that floods the gateway is slowed down", async () => {
  const small = createGateway({ token: SECRET, github, repo: REPO, branch: "main", loadCollection: async () => collection, rateLimitPerMinute: 2 });
  await new Promise<void>((r) => small.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(small.address() as AddressInfo).port}/mcp`;
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) statuses.push((await fetch(url, { method: "POST", body: "{}" })).status);
  assert.deepEqual(statuses, [401, 401, 429]);
  await new Promise<void>((r) => small.close(() => r()));
});
