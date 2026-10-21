/**
 * README.md as data: the category sections and their table rows.
 *
 * Only the row blocks are ever rewritten; every other line is kept exactly as
 * it was, so parse → serialize returns the original bytes. Row contract (the
 * same one mcp/scripts/build-data.ts relies on): `| [Name](url) | stars | desc |`
 * splits on " | " into exactly 3 cells, so no cell may contain a pipe.
 */
import type { CategoryMeta } from "./config.js";

export const TABLE_HEAD = "| რეპოზიტორია | ⭐ | აღწერა |";
export const TABLE_RULE = "|---|---|---|";
const GH = "https://github.com/";
const LINK = /^\| \[([^\]]+)\]\(([^)\s]+)\)$/;
const HEADING = /^## (\S+) (.+?)\s*$/;

export type Row = { name: string; url: string; stars: string; desc: string };
export type Section = CategoryMeta & { rows: Row[]; start: number; end: number };
export type ReadmeDoc = { lines: string[]; eol: string; sections: Section[] };

export class ReadmeError extends Error {
  override name = "ReadmeError";
}

/** "owner/repo" for GitHub repo URLs; the URL itself otherwise (blob pages, gists). */
export function pathOf(url: string): string {
  return url.startsWith(GH) ? url.slice(GH.length) : url;
}

const MULTIPLIER: Record<string, number> = { "": 1, K: 1_000, M: 1_000_000 };

export function starValue(cell: string): number {
  const m = /^(\d+(?:\.\d+)?)([KM]?)$/.exec(cell.trim());
  if (!m) return 0; // "Guide", "Gist": non-repo rows sort last
  return Math.round(Number(m[1]) * MULTIPLIER[m[2]!]!);
}

/**
 * The star cell exactly as the weekly refresh writes it (fmtStars in
 * mcp/scripts/refresh-stars.ts): 393 / 5.1K / 195K / 1.2M. Any other rounding
 * would make the two writers flip the same cell back and forth.
 */
export function kfmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(Math.round(n / 100) / 10).toFixed(1)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(Math.round(n / 100_000) / 10).toFixed(1)}M`;
}

export function parseRow(line: string): Row {
  const cells = line.split(" | ");
  if (cells.length !== 3 || !cells[2]!.endsWith(" |")) {
    throw new ReadmeError(`row does not split into 3 cells: ${line.slice(0, 90)}`);
  }
  const m = LINK.exec(cells[0]!);
  if (!m) throw new ReadmeError(`row link cell malformed: ${cells[0]!.slice(0, 90)}`);
  return { name: m[1]!, url: m[2]!, stars: cells[1]!, desc: cells[2]!.slice(0, -2) };
}

export function formatRow(r: Row): string {
  return `| [${r.name}](${r.url}) | ${r.stars} | ${r.desc} |`;
}

/** Problems with a row, or [] when it satisfies the contract. */
export function validateRow(r: Row): string[] {
  const errs: string[] = [];
  for (const [k, v] of Object.entries(r) as Array<[keyof Row, string]>) {
    if (v.includes("|") || v.includes("\n") || v !== v.trim() || v.includes("  ")) {
      errs.push(`${k}: pipe, newline or stray spacing`);
    }
  }
  if (r.name.includes("]") || r.name.includes("[")) errs.push("name: brackets break the link");
  if (/\s/.test(r.url) || r.url.includes(")")) errs.push("url: spaces or ')' break the link");
  if (!/^(\d+(\.\d)?[KM]|\d+|Guide|Gist)$/.test(r.stars)) errs.push(`stars: '${r.stars}' is not a star cell`);
  if (!/[.!?)»“"]$/.test(r.desc)) errs.push("desc: does not end a sentence");
  return errs;
}

export function parseReadme(text: string, categories: CategoryMeta[]): ReadmeDoc {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const byHeading = new Map(categories.map((c) => [c.georgian, c]));
  const sections: Section[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING.exec(lines[i]!);
    const cat = h ? byHeading.get(h[2]!) : undefined;
    if (!cat) continue;
    if (sections.some((s) => s.slug === cat.slug)) throw new ReadmeError(`category '${cat.georgian}' appears twice`);
    let j = i + 1;
    while (j < lines.length && j <= i + 8 && lines[j] !== TABLE_RULE) j++;
    if (lines[j] !== TABLE_RULE || lines[j - 1] !== TABLE_HEAD) {
      throw new ReadmeError(`no table under heading '${cat.georgian}'`);
    }
    const start = j + 1;
    let end = start;
    while (end < lines.length && lines[end]!.startsWith("| [")) end++;
    const rows = lines.slice(start, end).map((l, k) => {
      try {
        return parseRow(l);
      } catch (err) {
        throw new ReadmeError(`line ${start + k + 1}: ${(err as Error).message}`);
      }
    });
    sections.push({ ...cat, rows, start, end });
    i = end - 1;
  }
  const missing = categories.filter((c) => !sections.some((s) => s.slug === c.slug));
  if (missing.length > 0) {
    throw new ReadmeError(`categories not found in README: ${missing.map((c) => c.georgian).join(", ")}`);
  }
  return { lines, eol, sections };
}

export function serializeReadme(doc: ReadmeDoc): string {
  const out: string[] = [];
  const byStart = new Map(doc.sections.map((s) => [s.start, s]));
  for (let i = 0; i < doc.lines.length; i++) {
    const s = byStart.get(i);
    if (s) {
      out.push(...s.rows.map(formatRow));
      // skip the rows the file had; a table that had none owns no lines, so line i is kept
      if (s.end > s.start) {
        i = s.end - 1;
        continue;
      }
    }
    out.push(doc.lines[i]!);
  }
  // a table that ends the file starts after its last line
  const last = byStart.get(doc.lines.length);
  if (last) out.push(...last.rows.map(formatRow));
  return out.join(doc.eol);
}

export function section(doc: ReadmeDoc, slug: string): Section {
  const s = doc.sections.find((x) => x.slug === slug);
  if (!s) throw new ReadmeError(`unknown category '${slug}'`);
  return s;
}

export function findRow(doc: ReadmeDoc, path: string): { section: Section; index: number } | undefined {
  const want = path.toLowerCase();
  for (const s of doc.sections) {
    const index = s.rows.findIndex((r) => pathOf(r.url).toLowerCase() === want);
    if (index >= 0) return { section: s, index };
  }
  return undefined;
}

export function allPaths(doc: ReadmeDoc): string[] {
  return doc.sections.flatMap((s) => s.rows.map((r) => pathOf(r.url)));
}

export function totals(doc: ReadmeDoc): { repos: number; categories: number } {
  return { repos: doc.sections.reduce((n, s) => n + s.rows.length, 0), categories: doc.sections.length };
}

/** Insert before the first row with fewer stars — the list's own ordering rule. */
function insertByStars(s: Section, row: Row): void {
  const v = starValue(row.stars);
  const pos = s.rows.findIndex((r) => starValue(r.stars) < v);
  s.rows.splice(pos < 0 ? s.rows.length : pos, 0, row);
}

function assertValid(row: Row): void {
  const errs = validateRow(row);
  if (errs.length > 0) throw new ReadmeError(`invalid row ${row.name}: ${errs.join("; ")}`);
}

export function addRow(doc: ReadmeDoc, slug: string, row: Row): void {
  assertValid(row);
  if (findRow(doc, pathOf(row.url))) throw new ReadmeError(`${pathOf(row.url)} is already listed`);
  const clash = doc.sections.flatMap((s) => s.rows).find((r) => r.name.toLowerCase() === row.name.toLowerCase());
  if (clash) throw new ReadmeError(`display name '${row.name}' is already used by ${clash.url}`);
  insertByStars(section(doc, slug), row);
}

export function removeRow(doc: ReadmeDoc, path: string): Row {
  const hit = findRow(doc, path);
  if (!hit) throw new ReadmeError(`${path} is not listed`);
  return hit.section.rows.splice(hit.index, 1)[0]!;
}

/** Same repository under a new address: keeps its place, name and star cell. */
export function renameRow(doc: ReadmeDoc, oldPath: string, newPath: string): Row {
  const hit = findRow(doc, oldPath);
  if (!hit) throw new ReadmeError(`${oldPath} is not listed`);
  if (findRow(doc, newPath)) throw new ReadmeError(`${newPath} is already listed`);
  const next = { ...hit.section.rows[hit.index]!, url: GH + newPath };
  assertValid(next);
  hit.section.rows[hit.index] = next;
  return next;
}

export function setDescription(doc: ReadmeDoc, path: string, desc: string): Row {
  const hit = findRow(doc, path);
  if (!hit) throw new ReadmeError(`${path} is not listed`);
  const next = { ...hit.section.rows[hit.index]!, desc };
  assertValid(next);
  hit.section.rows[hit.index] = next;
  return next;
}

export function getRow(doc: ReadmeDoc, path: string): Row | undefined {
  const hit = findRow(doc, path);
  return hit ? hit.section.rows[hit.index] : undefined;
}
