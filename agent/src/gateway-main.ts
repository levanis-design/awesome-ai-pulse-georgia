/**
 * Entry point of the gateway container (Deploy ON). Fails closed: without a
 * long MCP_TOKEN and a GITHUB_TOKEN it refuses to start.
 */
import { createGateway } from "./gateway.js";
import { GitHub } from "./github.js";
import { log } from "./log.js";

export function startGateway(env = process.env): void {
  const token = env["MCP_TOKEN"] ?? "";
  const ghToken = env["GITHUB_TOKEN"] ?? "";
  if (token.length < 32) {
    log.error(
      "MCP_TOKEN is missing or shorter than 32 characters; refusing to start",
    );
    process.exit(1);
  }
  if (!ghToken) {
    log.error("GITHUB_TOKEN is missing; refusing to start");
    process.exit(1);
  }
  const repo =
    env["AGENT_REPO"] || "tornikebolokadze1-cyber/awesome-ai-pulse-georgia";
  const branch = env["AGENT_BRANCH"] || "main";
  const port = Number(env["PORT"] || "8080");
  const server = createGateway({
    token,
    github: new GitHub(ghToken, "aipulse-agent-gateway"),
    repo,
    branch,
  });
  server.listen(port, "0.0.0.0", () =>
    log.info("gateway listening", { port, repo, branch }),
  );
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && /gateway(-main)?\.(js|ts)$/.test(process.argv[1]))
  startGateway();
