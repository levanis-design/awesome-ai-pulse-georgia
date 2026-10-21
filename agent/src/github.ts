/**
 * Minimal GitHub client over fetch (REST + GraphQL). No SDK on purpose: the
 * gateway must fit a 64 MB container, and the agent only needs a dozen calls.
 */
import { log } from "./log.js";

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export type SearchItem = {
  full_name: string;
  stargazers_count: number;
  created_at: string;
  archived: boolean;
  fork: boolean;
  description: string | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The one method the issue store and the gateway need (and tests fake). */
export type RestClient = Pick<GitHub, "rest">;

export class GitHub {
  constructor(
    private readonly token: string | undefined,
    private readonly userAgent = "aipulse-agent",
  ) {}

  private headers(accept = "application/vnd.github+json"): Record<string, string> {
    const h: Record<string, string> = {
      Accept: accept,
      "User-Agent": this.userAgent,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  /** fetch with retries on 5xx and on GitHub's secondary rate limit. */
  private async send(url: string, init: RequestInit, attempt = 1): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      if (attempt >= 3) throw err;
      await sleep(1000 * attempt);
      return this.send(url, init, attempt + 1);
    }
    const retryable =
      res.status >= 500 || (res.status === 403 && res.headers.get("retry-after") !== null) || res.status === 429;
    if (retryable && attempt < 3) {
      const wait = Number(res.headers.get("retry-after") ?? "0") * 1000 || 2000 * attempt;
      log.warn("github retry", { url: url.replace(API, ""), status: res.status, wait });
      await sleep(Math.min(wait, 60_000));
      return this.send(url, init, attempt + 1);
    }
    return res;
  }

  async rest<T>(method: string, path: string, body?: unknown, accept?: string): Promise<T> {
    const init: RequestInit = { method, headers: this.headers(accept) };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    }
    const res = await this.send(`${API}${path}`, init);
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new GitHubError(`${method} ${path} → ${res.status}: ${text}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    const type = res.headers.get("content-type") ?? "";
    return (type.includes("json") ? await res.json() : await res.text()) as T;
  }

  /** GraphQL that tolerates per-alias errors (a deleted repo must not sink the batch). */
  async graphqlPartial<T>(query: string): Promise<{ data: T | null; errors: Array<{ path?: string[]; type?: string; message: string }> }> {
    const res = await this.send(`${API}/graphql`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new GitHubError(`graphql → ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
    const json = (await res.json()) as { data?: T; errors?: Array<{ path?: string[]; type?: string; message: string }> };
    return { data: json.data ?? null, errors: json.errors ?? [] };
  }

  async searchRepos(q: string, perPage = 50): Promise<SearchItem[]> {
    const params = new URLSearchParams({ q, sort: "stars", order: "desc", per_page: String(perPage) });
    const res = await this.rest<{ items: SearchItem[] }>("GET", `/search/repositories?${params}`);
    return res.items;
  }

  /**
   * Raw README text, or null when the repo has none. Read as text, not through rest():
   * GitHub labels the raw body `application/vnd.github.raw+json`, which is not JSON.
   */
  async readme(fullName: string): Promise<string | null> {
    const path = `/repos/${fullName}/readme`;
    const res = await this.send(`${API}${path}`, { headers: this.headers("application/vnd.github.raw+json") });
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubError(`GET ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
    return res.text();
  }

  /** Plain public page (GitHub trending). No token: the page is public HTML. */
  async page(url: string): Promise<string> {
    const res = await this.send(url, { headers: { "User-Agent": this.userAgent, Accept: "text/html" } });
    if (!res.ok) throw new GitHubError(`GET ${url} → ${res.status}`, res.status);
    return res.text();
  }
}
