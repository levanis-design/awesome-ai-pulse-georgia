/**
 * The owner's curation rules as small pure functions, so each one is testable
 * and the scan reads like the rulebook.
 */
import type { Rules } from "./config.js";
import type { RepoFacts } from "./facts.js";

export const DAY_MS = 86_400_000;

export const daysSince = (iso: string, now: Date): number => (now.getTime() - new Date(iso).getTime()) / DAY_MS;

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

/** The exclusion reason for a listed repo, by its README path or by the name GitHub now gives it. */
export function listedExclusion(path: string, f: RepoFacts | null, rules: Rules): string | null {
  return exclusionReason(path, rules) ?? (f ? exclusionReason(f.nameWithOwner, rules) : null);
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

/**
 * The first reason, decidable without a model, why a repo may not be added, or
 * null. The scan, an owner's suggestion and the apply step all ask this one
 * question, the last time on the day's own numbers.
 */
export function addBlocker(f: RepoFacts, rules: Rules, opts: { now: Date; requireStarBar: boolean }): string | null {
  const excluded = exclusionReason(f.nameWithOwner, rules);
  if (excluded) return `owner's exclusion list: ${excluded}`;
  if (f.isArchived || f.isDisabled) return "archived or disabled";
  if (f.isFork) return "a fork";
  const farming = farmingSigns(f, rules);
  if (farming.length > 0) return `star-farming signs: ${farming.join(", ")}`;
  if (opts.requireStarBar && !clearsStarBar(f, rules, opts.now)) return `${f.stars} stars is under the bar for its age`;
  if (!isVendor(f.nameWithOwner, rules) && f.stars < rules.thresholds.floorIndependent) {
    return `${f.stars} stars, under the ${rules.thresholds.floorIndependent} floor for independent projects`;
  }
  return null;
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

export function isStale(f: RepoFacts, rules: Rules, now: Date): boolean {
  return !f.isArchived && monthsSince(f.pushedAt, now) >= rules.thresholds.staleMonths;
}

/** Created within the discovery window: the lower star bar applies, and it is considered first. */
export function isNewRepo(f: RepoFacts, rules: Rules, now: Date): boolean {
  return daysSince(f.createdAt, now) <= rules.thresholds.discoverWindowDays;
}

/** Does a new or unlisted repo clear the star bar for its age? */
export function clearsStarBar(f: RepoFacts, rules: Rules, now: Date): boolean {
  return f.stars >= (isNewRepo(f, rules, now) ? rules.thresholds.minStarsNew : rules.thresholds.minStarsOld);
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
