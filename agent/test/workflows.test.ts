/**
 * The workflows are YAML these tests cannot run, so what they promise is
 * checked as text: the labels, file names and npm scripts they share with the
 * code, and the safety properties of the jobs that apply and push changes.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "../src/config.js";
import { SPOTS } from "../src/counts.js";
import { LABELS } from "../src/proposals.js";
import { formatRow } from "../src/readme.js";
import { CACHE_FILE } from "../src/scan.js";

const AGENT = ["agent-apply.yml", "agent-scan.yml", "agent-suggest.yml"];
const workflow = (name: string) =>
  readFileSync(
    resolve(REPO_ROOT, ".github", "workflows", name),
    "utf-8",
  ).replace(/\r\n/g, "\n");
const scriptsOf = (dir: string) =>
  (
    JSON.parse(
      readFileSync(resolve(REPO_ROOT, dir, "package.json"), "utf-8"),
    ) as { scripts: Record<string, string> }
  ).scripts;

/** Each job of a workflow by name, as its YAML text without comment lines. */
function jobsOf(text: string): Map<string, string> {
  const body = text.slice(text.indexOf("\njobs:\n") + 7);
  const jobs = new Map<string, string>();
  for (const part of body.split(/^(?= {2}[\w-]+:\s*$)/m)) {
    const name = /^ {2}([\w-]+):/.exec(part)?.[1];
    if (name)
      jobs.set(
        name,
        part
          .split("\n")
          .filter((l) => !l.trim().startsWith("#"))
          .join("\n"),
      );
  }
  return jobs;
}

/** The words of a folded `NAME: >-` (or one-line) value in the workflow's env. */
function listIn(text: string, name: string): string[] {
  const m = new RegExp(
    `^ {2}${name}: (?:>-\\n((?: {4}.+\\n)+)|(.+)\\n)`,
    "m",
  ).exec(text);
  assert.ok(m, `${name} is set in the workflow's env`);
  return (m[1] ?? m[2]!).trim().split(/\s+/);
}

const apply = workflow("agent-apply.yml");
const jobs = jobsOf(apply);
const job = (name: string) => {
  const text = jobs.get(name);
  assert.ok(text, `agent-apply.yml has a ${name} job`);
  return text;
};

test("every agent label a workflow names is one the code uses", () => {
  const known = new Set<string>(Object.values(LABELS));
  for (const name of AGENT)
    for (const m of workflow(name).matchAll(/'(agent:[a-z]+)'/g))
      assert.ok(known.has(m[1]!), `${name}: ${m[1]}`);
  assert.ok(
    workflow("agent-suggest.yml").includes(
      `github.event.label.name == '${LABELS.suggestion}'`,
    ),
  );
});

test("only the owner's own label events, or a manual start, run apply", () => {
  assert.match(
    job("prepare"),
    /if: github\.event_name == 'workflow_dispatch' \|\| github\.event\.sender\.login == github\.repository_owner\n/,
  );
  // one run at a time for the whole workflow, so a waiting run never mixes with a running one
  assert.match(
    apply,
    /^concurrency:\n {2}group: agent-apply\n {2}cancel-in-progress: false$/m,
  );
});

test("the workflows the gateway starts and lists are the ones that exist", () => {
  const gateway = readFileSync(
    resolve(REPO_ROOT, "agent", "src", "gateway.ts"),
    "utf-8",
  );
  const named = [
    ...new Set([...gateway.matchAll(/agent-[a-z]+\.yml/g)].map((m) => m[0])),
  ].sort();
  assert.deepEqual(named, AGENT);
  for (const name of named)
    assert.ok(
      existsSync(resolve(REPO_ROOT, ".github", "workflows", name)),
      name,
    );
});

test("every npm script a workflow runs exists in the package it runs in", () => {
  const agent = scriptsOf("agent");
  const mcp = scriptsOf("mcp");
  for (const name of AGENT) {
    for (const line of workflow(name).split("\n")) {
      for (const m of line.matchAll(/npm run ([\w:-]+)/g)) {
        assert.ok(
          m[1]! in (line.includes("--prefix mcp") ? mcp : agent),
          `${name}: ${line.trim()}`,
        );
      }
    }
  }
});

test("no checkout leaves a token behind, and no package runs code while it is installed", () => {
  for (const name of AGENT) {
    const text = workflow(name);
    const checkouts = text.match(/uses: actions\/checkout@/g)?.length ?? 0;
    assert.ok(checkouts > 0, name);
    assert.equal(
      text.match(/persist-credentials: false/g)?.length ?? 0,
      checkouts,
      name,
    );
    for (const line of text
      .split("\n")
      .filter((l) => /\bnpm (ci|install|version)\b/.test(l)))
      assert.match(line, /--ignore-scripts/, `${name}: ${line.trim()}`);
  }
});

test("only the push job can write to the repository, and it runs no package code at all", () => {
  assert.match(apply, /^permissions: \{\}$/m); // nothing by default
  const prepare = job("prepare");
  assert.match(prepare, /contents: read/);
  assert.doesNotMatch(prepare, /: write/);
  const tell = job("tell");
  assert.match(tell, /issues: write/);
  assert.doesNotMatch(tell, /contents: write|actions: write/);
  const push = job("push");
  assert.match(push, /contents: write/);
  // a step's name runs nothing; every other line of the job may not even mention them
  const commands = push
    .split("\n")
    .filter((l) => !/^\s*(- )?name:/.test(l))
    .join("\n");
  assert.doesNotMatch(commands, /\b(npm|npx|node|tsx|setup-node)\b/);
  // and no git hook runs there either
  const gitWrites = push
    .split("\n")
    .filter((l) => /\bgit\b.*\b(commit|push)\b/.test(l));
  assert.equal(gitWrites.length, 2);
  for (const line of gitWrites)
    assert.match(line, /git -c core\.hooksPath=\/dev\/null /, line.trim());
});

test("the push job takes only planned files, and checks their shape as data", () => {
  const changeable = listIn(apply, "CHANGEABLE");
  // what apply writes (the README, every count spot, the English cache) plus what the rebuild derives
  const derived = [
    CACHE_FILE,
    "mcp/data/repos.json",
    "docs/data.js",
    "site/public/data/graph.json",
    "mcp/package-lock.json",
  ];
  assert.deepEqual(
    new Set(changeable),
    new Set([...SPOTS.map((s) => s.file), ...derived]),
  );
  assert.equal(changeable.length, new Set(changeable).size);
  // everything but the README may change only in its numbers: the counts and the package version
  const numbersOnly = new Set(listIn(apply, "NUMBERS_ONLY"));
  assert.deepEqual(
    numbersOnly,
    new Set([
      ...SPOTS.map((s) => s.file).filter((f) => f !== "README.md"),
      "mcp/package-lock.json",
    ]),
  );
  assert.deepEqual(
    new Set(listIn(apply, "JSON_ONLY")),
    new Set([CACHE_FILE, "mcp/data/repos.json", "site/public/data/graph.json"]),
  );
  const push = job("push");
  // what the commit would change, the old name of a moved file included, each path compared
  // whole: a substring test lets "docs/index.html site/index.html" pass for two listed names
  assert.ok(push.includes("git diff --cached --numstat --no-renames"));
  assert.ok(push.includes(`[ "$f" = "$1" ] && return 0`));
  assert.doesNotMatch(push, /\*" \$\{path\} "\*/);
  assert.ok(push.includes(`awk '$1 != "100644"'`));
  // the count files' own check, named in full: the README check below normalises digits the same way
  assert.ok(
    push.includes(
      `if ! cmp -s <(git show "HEAD:\${f}" | sed -E 's/[0-9]+/0/g') <(sed -E 's/[0-9]+/0/g' "$f"); then`,
    ),
  );
  // the README may change only in its table rows and numbers, and may not go away; a row is
  // what formatRow writes, so if that ever changes, this check has to change with it
  assert.ok(
    push.includes(
      `<(git show HEAD:README.md | grep -v '^| \\[' | sed -E 's/[0-9]+/0/g')`,
    ),
  );
  assert.ok(
    push.includes(`<(grep -v '^| \\[' README.md | sed -E 's/[0-9]+/0/g')`),
  );
  assert.ok(
    formatRow({
      name: "n",
      url: "https://github.com/o/r",
      stars: "1",
      desc: "d.",
    }).startsWith("| ["),
  );
  assert.ok(push.includes(`jq -se 'length == 1'`));
  assert.ok(
    push.includes(`[ "$(head -c 17 docs/data.js)" != "window.AIPULSE = " ]`),
  );
  // prepare refuses a change nobody planned, tracked or untracked
  assert.ok(
    job("prepare").includes("git status --porcelain --untracked-files=all"),
  );
});

test("apply pushes only a checked change, and tells the issues even after a failed job", () => {
  assert.doesNotMatch(apply, /pull --rebase|push --force|--no-verify/);
  assert.match(
    job("push"),
    /if: needs\.prepare\.result == 'success' && needs\.prepare\.outputs\.applied != '0'\n/,
  );
  assert.ok(job("push").includes(`extraheader="AUTHORIZATION: basic`));
  const tell = job("tell");
  assert.ok(
    tell.includes(
      "if: always() && needs.prepare.result != 'skipped' && needs.prepare.result != 'cancelled'",
    ),
  );
  assert.ok(tell.includes("continue-on-error: true"));
  assert.ok(tell.includes(`CHANGE_URL: \${{ needs.push.outputs.url }}`));
});
