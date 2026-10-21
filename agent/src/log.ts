/**
 * One-line JSON logs on stderr, so workflow logs and the gateway's platform
 * logs stay greppable. Never pass secrets in `fields`.
 */
type Level = "info" | "warn" | "error";

const quiet = process.env["AGENT_LOG_LEVEL"] === "warn";

function write(
  level: Level,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  if (quiet && level === "info") return;
  process.stderr.write(
    `${JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields })}\n`,
  );
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) =>
    write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) =>
    write("error", msg, fields),
};
