/**
 * aipulse-agent — the curator's commands, run by the GitHub workflows:
 *   scan     check listed repos, look for new ones, file proposals
 *            (--memory file keeps the model's verdicts between runs)
 *   suggest  answer one owner suggestion issue (--issue N)
 *   apply    apply approved proposals to the working tree (--out result.json)
 *   verify   check that the README, every count and the rebuilt data agree (exit 1 if not)
 *   report   tell the issues how apply went (--result file, --commit URL | --error text)
 *   serve    run the MCP gateway locally
 * scan, suggest, apply and report take --dry-run (nothing is written to GitHub or to files).
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { reportApply, runApply, type ApplyResult } from "./apply.js";
import { loadCategories, loadRules, REPO_ROOT } from "./config.js";
import { startGateway } from "./gateway-main.js";
import { GitHub } from "./github.js";
import { llmFromEnv } from "./llm.js";
import { log } from "./log.js";
import { loadMemory, saveMemory } from "./memory.js";
import { NO_AI_SIGNAL, runScan, runSuggestion, type Ctx, type ScanReport } from "./scan.js";
import { verifyTree } from "./verify.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean", default: false },
    "no-discover": { type: "boolean", default: false },
    "max-new": { type: "string" },
    memory: { type: "string" },
    out: { type: "string" },
    issue: { type: "string" },
    issues: { type: "string" },
    result: { type: "string" },
    commit: { type: "string" },
    error: { type: "string" },
  },
});

function context(): Ctx {
  return {
    gh: new GitHub(process.env["GITHUB_TOKEN"]),
    rules: loadRules(),
    categories: loadCategories(),
    root: REPO_ROOT,
    llm: llmFromEnv(),
    now: new Date(),
  };
}

/** A short Markdown summary for the workflow run page (and for people reading logs). */
function summarize(r: ScanReport): string {
  const lines = [
    `## აგენტის სკანი — ${r.started.slice(0, 16).replace("T", " ")} UTC`,
    "",
    `სიაში ${r.listed} რეპოა. ახალი შეთავაზება: **${r.proposals.length}**${r.filed.length ? ` (შეიქმნა: ${r.filed.map((f) => `#${f.number}`).join(", ")})` : ""}.`,
    "",
    "| წყარო | მუშაობს | იპოვა |",
    "|---|---|---|",
    ...r.sources.map((s) => `| ${s.source} | ${s.ok ? "✅" : `❌ ${s.error ?? ""}`} | ${s.found} |`),
  ];
  if (r.notes.length) lines.push("", ...r.notes.map((n) => `- ⚠️ ${n}`));
  if (r.proposals.length) lines.push("", "### შეთავაზებები", ...r.proposals.map((p) => `- ${p.type}: ${"repo" in p ? p.repo : p.type === "rename" ? `${p.from} → ${p.to}` : `${p.updates.length} updates`}`));
  // repos without any AI signal are the bulk of the trending pages: count them, list the rest
  const noSignal = r.skipped.filter((s) => s.why === NO_AI_SIGNAL).length;
  const other = r.skipped.filter((s) => s.why !== NO_AI_SIGNAL);
  if (other.length) lines.push("", `### გამოტოვებული (${other.length})`, ...other.slice(0, 30).map((s) => `- ${s.repo}: ${s.why}`));
  if (noSignal) lines.push("", `AI-სთან კავშირის გარეშე, მოდელისთვის არ გადაცემულა: ${noSignal}`);
  if (r.held.length) lines.push("", `შეკავებული (უკვე შეთავაზებულია ან უარყოფილია): ${r.held.length}`);
  return lines.join("\n");
}

function toStepSummary(md: string): void {
  const file = process.env["GITHUB_STEP_SUMMARY"];
  if (file) appendFileSync(file, `${md}\n`);
}

function setOutput(name: string, value: string): void {
  const file = process.env["GITHUB_OUTPUT"];
  if (file) appendFileSync(file, `${name}=${value}\n`);
}

async function main(): Promise<void> {
  const cmd = positionals[0];
  const dryRun = values["dry-run"] === true;
  switch (cmd) {
    case "scan": {
      const ctx = context();
      const memory = loadMemory(values.memory);
      const report = await runScan(ctx, {
        dryRun,
        discover: values["no-discover"] !== true,
        memory,
        ...(values["max-new"] ? { maxNew: Number(values["max-new"]) } : {}),
      });
      if (values.memory && !dryRun) saveMemory(values.memory, memory, ctx.now);
      if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2));
      const md = summarize(report);
      toStepSummary(md);
      process.stdout.write(`${md}\n`);
      const broken = report.sources.filter((s) => !s.ok);
      if (broken.length === report.sources.length) process.exitCode = 2; // nothing was checked at all
      return;
    }
    case "suggest": {
      const n = Number(values.issue);
      if (!Number.isInteger(n) || n <= 0) throw new Error("suggest needs --issue <number>");
      const r = await runSuggestion(context(), n, dryRun);
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return;
    }
    case "apply": {
      const numbers = values.issues ? values.issues.split(",").map(Number).filter(Number.isInteger) : undefined;
      const result = await runApply(context(), { dryRun, ...(numbers ? { numbers } : {}) });
      if (values.out) writeFileSync(values.out, JSON.stringify(result, null, 2));
      setOutput("applied", String(result.applied.length));
      setOutput("failed", String(result.failed.length));
      const md = [
        `## აგენტი: დამტკიცებული ცვლილებები`,
        `რეპოები: ${result.counts.before.repos} → ${result.counts.after.repos}`,
        ...result.applied.map((a) => `- ✅ #${a.number} ${a.summary}`),
        ...result.failed.map((f) => `- ⚠️ #${f.number} ${f.error}`),
      ].join("\n");
      toStepSummary(md);
      process.stdout.write(`${md}\n`);
      return;
    }
    case "report": {
      if (!values.result) throw new Error("report needs --result <apply-result.json>");
      const result = JSON.parse(readFileSync(values.result, "utf-8")) as ApplyResult;
      if (dryRun) {
        process.stdout.write(`would report ${result.applied.length} applied, ${result.failed.length} failed\n`);
        return;
      }
      await reportApply(context(), result, { ...(values.commit ? { changeUrl: values.commit } : {}), ...(values.error ? { error: values.error } : {}) });
      return;
    }
    case "verify": {
      const problems = verifyTree(REPO_ROOT, loadCategories());
      for (const p of problems) process.stderr.write(`✗ ${p}\n`);
      process.stdout.write(problems.length ? `${problems.length} problem(s)\n` : "✓ README, counts and generated data agree\n");
      if (problems.length) process.exitCode = 1;
      return;
    }
    case "serve":
      startGateway();
      return;
    default:
      process.stderr.write("usage: cli.ts <scan|suggest|apply|verify|report|serve> [--dry-run] ...\n");
      process.exitCode = 64;
  }
}

main().catch((err: unknown) => {
  log.error("agent failed", { error: (err as Error).message });
  process.exitCode = 1;
});
