import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Diagnostic, Range } from "./diagnostics";
import type { Common, DomainClause, DomainDecl, DomainModel, Statement } from "./cst";
import type { Token } from "./lexer";
import { joinTokens, lex, tokenRange } from "./lexer";
import { parse } from "./parser";

/**
 * A run is the files a command was handed; a domain is every file in the run whose header names
 * it (§1). Callers see domains, never files: expansion, lexing, parsing, grouping, and the merge
 * of the domain's clauses all live here.
 */

export function isModelFile(path: string): boolean {
  return /\.(meant|md)$/.test(path);
}
const ORIGIN = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };

/** Model files under a path: `.meant` files, plus `.md` hosts whose fences carry models. */
export function expand(path: string): string[] {
  const info = statSync(path);
  if (!info.isDirectory()) return isModelFile(path) ? [path] : [];
  const out: string[] = [];
  for (const entry of readdirSync(path).sort()) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    out.push(...expand(join(path, entry)));
  }
  return out;
}

export interface Expansion { files: string[]; unreadable: Diagnostic[] }

/**
 * Expand paths to model files, reporting the unreadable ones instead of throwing.
 *
 * Every command shares this, because a mistyped path is an ordinary finding — the same `P` law,
 * the same message, the same exit code — and not a stack trace whose shape depends on which verb
 * you happened to type.
 */
export function expandAll(paths: string[]): Expansion {
  const files: string[] = [];
  const unreadable: Diagnostic[] = [];
  for (const path of paths) {
    try {
      files.push(...expand(path));
    } catch {
      unreadable.push({
        law: "P", code: "unreadable-path", severity: "error",
        message: `\`${path}\` cannot be read.`, file: path, range: ORIGIN,
        fix: "check the path, or point at a .meant file or a directory of them",
      });
    }
  }
  return { files, unreadable };
}

export interface Domain {
  /** The header's name; null for a file with statements but no header — always its own domain. */
  name: string | null;
  files: string[];
  model: DomainModel;
  /** Lexical and structural findings on the domain's files, plus clause conflicts across them. */
  diagnostics: Diagnostic[];
}

export interface Run {
  files: string[];
  /** Findings that belong to no domain: unreadable paths, and files with nothing to model. */
  diagnostics: Diagnostic[];
  /** In order of each domain's first file. */
  domains: Domain[];
  index: RunIndex;
}

/**
 * What every domain in the run declares, by name. A reference that resolves nowhere in its own
 * domain but somewhere in another is usually a misspelled header — the resolver says so.
 */
export interface RunIndex {
  domains: string[];
  declared: ReadonlyMap<string, ReadonlyArray<{ domain: string; token: Token }>>;
}

export const EMPTY_INDEX: RunIndex = { domains: [], declared: new Map() };

function indexOf(domains: Domain[]): RunIndex {
  const declared = new Map<string, Array<{ domain: string; token: Token }>>();
  const add = (domain: string, token: Token | null) => {
    if (!token) return;
    const entries = declared.get(token.text);
    if (entries) entries.push({ domain, token }); else declared.set(token.text, [{ domain, token }]);
  };
  for (const d of domains) {
    if (d.name === null) continue;
    for (const st of d.model.statements) {
      if (st.kind === "touchpoints" || st.kind === "exposure") continue;
      add(d.name, st.name);
      if ("id" in st) add(d.name, st.id);
    }
  }
  return { domains: domains.flatMap(d => (d.name === null ? [] : [d.name])), declared };
}

interface Part { file: string; domain: DomainDecl | null; statements: Statement[]; diagnostics: Diagnostic[] }

export function load(paths: string[]): Run {
  const { files, unreadable } = expandAll(paths);
  const diagnostics: Diagnostic[] = [...unreadable];
  const groups: Array<{ name: string | null; parts: Part[] }> = [];
  const named = new Map<string, Part[]>();

  for (const file of files) {
    const lexed = lex(readFileSync(file, "utf8"), file);
    const parsed = parse(lexed);
    const found = [...lexed.diagnostics, ...parsed.diagnostics];
    const { domain, statements } = parsed.model;
    if (domain === null && statements.length === 0) { diagnostics.push(...found); continue }
    const part: Part = { file, domain, statements, diagnostics: found };
    const name = domain?.name.text ?? null;
    const parts = name === null ? undefined : named.get(name);
    if (parts) { parts.push(part); continue }
    const fresh = [part];
    if (name !== null) named.set(name, fresh);
    groups.push({ name, parts: fresh });
  }

  const domains = groups.map(({ name, parts }): Domain => ({
    name, files: parts.map(p => p.file), ...merge(parts),
  }));
  return { files, diagnostics, domains, index: indexOf(domains) };
}

type Uses = Extract<DomainClause, { kind: "uses" }>;

/**
 * One domain from its files: statements concatenate; clauses may sit in any file, but one key
 * carries one value across all of them — a second, different value is a conflict (§1, E54).
 */
function merge(parts: Part[]): { model: DomainModel; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = parts.flatMap(p => p.diagnostics);
  const statements = parts.flatMap(p => p.statements);
  const headers = parts.flatMap(p => (p.domain ? [p.domain] : []));
  const first = headers[0];
  if (!first) return { model: { domain: null, statements }, diagnostics };

  const seen = new Map<string, { value: string; shown: string; file: string; line: number }>();
  const clauses: DomainClause[] = [];
  let uses: Uses | null = null;
  const common: Common = { doc: null, notes: [], verifiedBy: [], planned: false, markers: [] };

  /** True when the key is already taken — by the same value (fine) or a different one (reported). */
  const taken = (key: string, value: string, shown: string, file: string, range: Range): boolean => {
    const prior = seen.get(key);
    if (!prior) { seen.set(key, { value, shown, file, line: range.start.line }); return false }
    if (prior.value === value) return true;
    diagnostics.push({
      law: "P", code: "domain-clause-conflict", severity: "error",
      message: `${shown} conflicts with ${prior.shown} at ${prior.file}:${prior.line} — a domain's clauses carry one value across all its files (§1).`,
      file, range, fix: "make the values agree, or keep the clause in one file",
    });
    return true;
  };

  for (const header of headers) {
    for (const clause of header.clauses) {
      if (clause.kind === "uses") {
        if (uses === null) { uses = { ...clause, libs: [...clause.libs] }; clauses.push(uses); continue }
        for (const lib of clause.libs) if (!uses.libs.some(l => l.text === lib.text)) uses.libs.push(lib);
        continue;
      }
      const key = clause.kind === "mode" ? "mode" : clause.key.text;
      const value = clause.kind === "mode" ? clause.value.text : joinTokens(clause.value);
      if (!taken(key, value, `\`${key} ${value}\``, header.file, clause.range)) clauses.push(clause);
    }
    const doc = header.common.doc;
    if (doc && !taken("docstring", doc.value, "the domain docstring", header.file, tokenRange(doc, doc))) common.doc = doc;
    common.notes.push(...header.common.notes);
    common.verifiedBy.push(...header.common.verifiedBy);
    common.markers.push(...header.common.markers);
    common.planned = common.planned || header.common.planned;
  }

  return { model: { domain: { ...first, clauses, common }, statements }, diagnostics };
}
