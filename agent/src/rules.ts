/**
 * The owner's curation rules as small pure functions, so each one is testable
 * and the scan reads like the rulebook.
 */
import type { Rules } from "./config.js";
import type { RepoFacts } from "./facts.js";

/** Why this repo must never be proposed, or null. Checks exact paths, then name patterns. */
export function exclusionReason(path: string, rules: Rules): string | null {
  const lower = path.toLowerCase();
  for (const [repo, reason] of Object.entries(rules.exclude.repos)) {
    if (repo.toLowerCase() === lower) return reason;
  }
  for (const { pattern, reason } of rules.exclude.namePatterns) {
    if (new RegExp(pattern, "i").test(lower)) return reason;
  }
  return null;
}

export function ownerOf(path: string): string {
  return path.split("/")[0] ?? "";
}

/** Official vendor and vendor-lab repos stay regardless of stars. */
export function isVendor(path: string, rules: Rules): boolean {
  const owner = ownerOf(path).toLowerCase();
  return rules.vendorOwners.some((o) => o.toLowerCase() === owner);
}

/** Signs of bought stars. Empty = looks organic. Labs often publish a squashed history, so vendors are not judged by it. */
export function farmingSigns(f: RepoFacts, rules: Rules): string[] {
  if (isVendor(f.nameWithOwner, rules)) return [];
  const signs: string[] = [];
  const ratio = f.stars > 0 ? f.forks / f.stars : 1;
  if (f.stars >= 1000 && ratio < rules.thresholds.minForkRatio) {
    signs.push(`forks/stars ${ratio.toFixed(4)} < ${rules.thresholds.minForkRatio}`);
  }
  if (f.commits !== null && f.commits < rules.thresholds.minCommits && f.stars >= 2000) {
    signs.push(`${f.commits} commits for ${f.stars} stars`);
  }
  return signs;
}

/** True when an independent listed repo has sunk clearly under the floor. */
export function belowFloor(path: string, f: RepoFacts, rules: Rules): boolean {
  if (isVendor(path, rules)) return false;
  return f.stars < rules.thresholds.floorIndependent * rules.thresholds.floorSlack;
}

export function monthsSince(iso: string, now: Date): number {
  const then = new Date(iso);
  return (now.getUTCFullYear() - then.getUTCFullYear()) * 12 + (now.getUTCMonth() - then.getUTCMonth());
}

export function isStale(f: RepoFacts, rules: Rules, now = new Date()): boolean {
  return !f.isArchived && monthsSince(f.pushedAt, now) >= rules.thresholds.staleMonths;
}

/** Does a new or unlisted repo clear the star bar for its age? */
export function clearsStarBar(f: RepoFacts, rules: Rules, now = new Date()): boolean {
  const ageDays = (now.getTime() - new Date(f.createdAt).getTime()) / 86_400_000;
  const bar = ageDays <= rules.thresholds.discoverWindowDays ? rules.thresholds.minStarsNew : rules.thresholds.minStarsOld;
  return f.stars >= bar;
}

const GEN = ["იანვრის", "თებერვლის", "მარტის", "აპრილის", "მაისის", "ივნისის", "ივლისის", "აგვისტოს", "სექტემბრის", "ოქტომბრის", "ნოემბრის", "დეკემბრის"];

/** The dated stale note, in the README's own wording: "შენიშვნა: 2025 წლის მაისის შემდეგ აღარ განახლებულა." */
export function staleNote(pushedAt: string): string {
  const d = new Date(pushedAt);
  return `შენიშვნა: ${d.getUTCFullYear()} წლის ${GEN[d.getUTCMonth()]} შემდეგ აღარ განახლებულა.`;
}

/** Already says it went quiet, in any wording? Then do not add another note. */
export function hasStaleNote(desc: string): boolean {
  return /შენიშვნა:.*(აღარ|შეჩერდა|დაარქივ|დაიხურა)|აღარ (განახლ|ვითარდ)|განვითარება შეჩერ|შეჩერებულია|დაარქივებულია/.test(desc);
}

const AI_WORDS =
  /\b(ai|llms?|gpt\w*|agents?|agentic|mcp|claude|codex|gemini|openai|anthropic|rag|copilot|chatbots?|prompts?|embeddings?|vector|transformers?|diffusion|tts|asr|stt|speech|voice|whisper|ocr|machine[- ]learning|deep[- ]learning|neural|inference|fine-?tun\w*|lora|ollama|llama\w*|qwen\w*|deepseek|mistral|langchain|langgraph|generative|genai|nlp|computer[- ]vision|ml|text-to-\w+)\b/i;

/** A free first look before any model is asked: does the name, description or a topic say AI at all? */
export function aiSignal(f: RepoFacts): boolean {
  return AI_WORDS.test([f.nameWithOwner.replace(/[/_.]/g, " "), f.description ?? "", ...f.topics].join(" "));
}
