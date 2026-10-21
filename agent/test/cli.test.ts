/** The command line refuses arguments that would quietly widen what it does, before it touches GitHub. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const agent = fileURLToPath(new URL("..", import.meta.url));
const tsx = fileURLToPath(
  new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url),
);

/** Run the CLI as a workflow would, but off a runner unless `extra` says otherwise. */
function run(extra: Record<string, string>, ...args: string[]) {
  // no token at all: if the arguments were accepted, the first GitHub call would fail differently
  const env = {
    ...process.env,
    GITHUB_TOKEN: "",
    ANTHROPIC_API_KEY: "",
    AGENT_LOG_LEVEL: "warn",
    GITHUB_ACTIONS: "",
    ...extra,
  };
  return spawnSync(process.execPath, [tsx, "src/cli.ts", ...args], {
    cwd: agent,
    encoding: "utf-8",
    env,
    timeout: 60_000,
  });
}

const cli = (...args: string[]) => run({}, ...args);

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

test("on a runner, reports are printed with workflow commands switched off around them", () => {
  const dir = mkdtempSync(join(tmpdir(), "aipulse-cli-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const result = join(dir, "result.json");
  const failed = [{ number: 1, title: "", error: "x" }];
  writeFileSync(result, JSON.stringify({ applied: [], failed }));
  const args = ["report", "--dry-run", "--result", result];
  assert.equal(cli(...args).stdout, "would report 0 applied, 1 failed\n");

  const onRunner = () => run({ GITHUB_ACTIONS: "true" }, ...args).stdout;
  const wrapped =
    /^::stop-commands::([0-9a-f]{32})\nwould report 0 applied, 1 failed\n::([0-9a-f]{32})::\n$/;
  const m = wrapped.exec(onRunner());
  assert.ok(m, "the report sits between a stop and a matching resume");
  // commands come back on only at the marker that switched them off
  assert.equal(m[1], m[2]);
  // and that marker is new every time, so no text can know it in advance
  assert.notEqual(wrapped.exec(onRunner())?.[1], m[1]);
});

test("an unknown command prints the usage and exits 64", () => {
  const r = cli("deploy");
  assert.equal(r.status, 64);
  assert.match(
    r.stderr,
    /usage: cli\.ts <scan\|suggest\|apply\|verify\|report\|serve>/,
  );
});
