/** The command line refuses arguments that would quietly widen what it does, before it touches GitHub. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const agent = fileURLToPath(new URL("..", import.meta.url));
const tsx = fileURLToPath(
  new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url),
);

function cli(...args: string[]) {
  // no token at all: if the arguments were accepted, the first GitHub call would fail differently
  const env = {
    ...process.env,
    GITHUB_TOKEN: "",
    ANTHROPIC_API_KEY: "",
    AGENT_LOG_LEVEL: "warn",
  };
  return spawnSync(process.execPath, [tsx, "src/cli.ts", ...args], {
    cwd: agent,
    encoding: "utf-8",
    env,
    timeout: 60_000,
  });
}

test("a mistyped --issues list is refused instead of applying every approved issue", () => {
  const r = cli("apply", "--dry-run", "--issues", "12,abc");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /--issues needs issue numbers/);
});

test("a mistyped --max-new is refused instead of lifting the model budget", () => {
  const r = cli("scan", "--dry-run", "--max-new", "lots");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /--max-new needs a whole number/);
});

test("an unknown command prints the usage and exits 64", () => {
  const r = cli("deploy");
  assert.equal(r.status, 64);
  assert.match(
    r.stderr,
    /usage: cli\.ts <scan\|suggest\|apply\|verify\|report\|serve>/,
  );
});
