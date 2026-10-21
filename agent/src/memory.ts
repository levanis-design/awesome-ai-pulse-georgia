/**
 * What the model already decided about repos it turned down, so the same
 * popular-but-unfitting repo is not drafted again every day. The scan
 * workflow keeps this file in its cache between runs; losing it only costs
 * one re-evaluation per repo.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { daysSince } from "./rules.js";

export type Verdict = { verdict: string; at: string; stars: number };
export type Memory = Record<string, Verdict>;

const KEEP_DAYS = 30;

export function loadMemory(path: string | undefined): Memory {
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Memory;
  } catch {
    return {}; // first run, or the cache was evicted
  }
}

/** Write it back without the verdicts that are too old to matter. */
export function saveMemory(path: string, memory: Memory, now: Date): void {
  const keep = Object.fromEntries(
    Object.entries(memory).filter(([, v]) => daysSince(v.at, now) < KEEP_DAYS),
  );
  writeFileSync(path, `${JSON.stringify(keep, null, 2)}\n`, "utf-8");
}

/** The earlier verdict, if it is under 30 days old and the repo has not since doubled its stars. */
export function judgedRecently(
  memory: Memory,
  path: string,
  stars: number,
  now: Date,
): Verdict | null {
  const v = memory[path.toLowerCase()];
  return v && daysSince(v.at, now) < KEEP_DAYS && stars < v.stars * 2 ? v : null;
}

export function remember(
  memory: Memory,
  path: string,
  verdict: string,
  stars: number,
  now: Date,
): void {
  memory[path.toLowerCase()] = { verdict, at: now.toISOString(), stars };
}
