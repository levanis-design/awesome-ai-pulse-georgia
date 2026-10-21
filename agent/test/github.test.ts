import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHub, GitHubError } from "../src/github.js";

// what GitHub sends for a README asked for as raw: markdown, labelled application/vnd.github.raw+json
const MD =
  '<p align="center">\n  <img src="assets/logo.svg">\n</p>\n\n# STORM {a curly brace, as READMEs have}\n';

test("a README comes back as its text, though GitHub labels the raw body raw+json", async (t) => {
  const f = t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(MD, {
        status: 200,
        headers: {
          "content-type": "application/vnd.github.raw+json; charset=utf-8",
        },
      }),
  );
  assert.equal(await new GitHub("t").readme("stanford-oval/storm"), MD);
  const [url, init] = f.mock.calls[0]!.arguments as [string, RequestInit];
  assert.equal(url, "https://api.github.com/repos/stanford-oval/storm/readme");
  assert.match(
    (init.headers as Record<string, string>)["Accept"]!,
    /^application\/vnd\.github\.raw/,
  );
});

test("a repo without a README gives null, and any other failure is reported", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response('{"message":"Not Found"}', {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
  );
  assert.equal(await new GitHub("t").readme("someone/no-readme"), null);
  t.mock.restoreAll();
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response('{"message":"Forbidden"}', {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
  );
  await assert.rejects(
    new GitHub("t").readme("someone/private"),
    (err: unknown) => err instanceof GitHubError && err.status === 403,
  );
});
