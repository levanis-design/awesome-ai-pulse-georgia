/**
 * The workflows are YAML these tests cannot run, so what they promise is
 * checked as text: the labels, file names and npm scripts they share with the
 * code, and the safety properties of the job that pushes to main.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "../src/config.js";
import { LABELS } from "../src/proposals.js";

const AGENT = ["agent-apply.yml", "agent-scan.yml", "agent-suggest.yml"];
const workflow = (name: string) =>
  readFileSync(resolve(REPO_ROOT, ".github", "workflows", name), "utf-8");
const scriptsOf = (dir: string) =>
  (
    JSON.parse(
      readFileSync(resolve(REPO_ROOT, dir, "package.json"), "utf-8"),
    ) as { scripts: Record<string, string> }
  ).scripts;

test("every agent label a workflow names is one the code uses", () => {
  const known = new Set<string>(Object.values(LABELS));
  for (const name of AGENT)
    for (const m of workflow(name).matchAll(/'(agent:[a-z]+)'/g))
      assert.ok(known.has(m[1]!), `${name}: ${m[1]}`);
  assert.ok(
    workflow("agent-apply.yml").includes(
      `github.event.label.name == '${LABELS.approved}' && github.event.sender.login == github.repository_owner`,
    ),
  );
  assert.ok(
    workflow("agent-suggest.yml").includes(
      `github.event.label.name == '${LABELS.suggestion}'`,
    ),
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

test("no checkout leaves a token behind for install scripts or tests to find", () => {
  for (const name of AGENT) {
    const text = workflow(name);
    const checkouts = text.match(/uses: actions\/checkout@/g)?.length ?? 0;
    assert.ok(checkouts > 0, name);
    assert.equal(
      text.match(/persist-credentials: false/g)?.length ?? 0,
      checkouts,
      name,
    );
  }
});

test("apply pushes only what it planned and checked, and tells the issues even after a failed step", () => {
  const text = workflow("agent-apply.yml");
  assert.doesNotMatch(text, /pull --rebase|push --force|--no-verify/);
  assert.ok(text.includes(`jq -r '.changedFiles[]'`));
  assert.ok(text.includes(`stray="$(git diff --name-only)"`));
  assert.ok(text.includes(`extraheader="AUTHORIZATION: basic`));
  const tell = text.slice(text.indexOf("- name: Tell the issues"));
  assert.ok(tell.includes("if: always() && steps.apply.outcome != 'skipped'"));
  assert.ok(tell.includes(`if [ ! -f "$result" ]`));
});
