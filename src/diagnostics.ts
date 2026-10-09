export type Severity = "error" | "warning" | "info";

export interface Position { line: number; col: number }          // 1-based
export interface Range { start: Position; end: Position }

export interface Diagnostic {
  /**
   * The law the diagnostic cites — API, keyed on by agents and goldens.
   * `V1`–`V15`: the spec §7 validator obligations.
   * `P`: a structural/lexical violation of the productions themselves (§1–§4, §17); the message cites the section.
   * `L-…`: structural smells (info only) — documented in laws.ts.
   */
  law: string;
  code: string;         // stable kebab slug, e.g. "unresolved-ref", "actor-condition-universal"
  severity: Severity;
  message: string;      // human sentence; names the offending token and the law's demand
  file: string;
  range: Range;
  fix?: string;         // one-line fix-shape, e.g. 'declare `concept Billing` or remove the ref'
}

/**
 * A simulation verdict: what the witness / probe / replay engines concluded about one claim.
 * `status` is API alongside `law`/`code` — the SIM-EXPECT harness and agents key on it.
 */
export interface Verdict {
  kind: "witness" | "probe" | "replay" | "machine";
  /** Claim identity: a ShapeName, `<Action>:<TargetShape>`, or `<Scenario>#<step>`. */
  subject: string;
  status:
    | "verified"      // the claim held under every sampled witness within scope
    | "falsified"     // a counterexample exists — reported shrunk
    | "dead"          // no witness satisfies the predicate: dead vocabulary
    | "unprobeable"   // opaque effects block the evaluation (partiality, not failure)
    | "skipped"       // out of scope by declaration (prose, lanes, fuse advancement)
    | "derived";      // a landing the effects imply, authored nowhere
  message: string;
  file: string;
  range: Range;
  /** Shrunk counterexample, one `field = value` per entry. */
  counterexample?: string[];
  evidence?: string[];
}

/** One declaration's unverified surface — the partiality account, never overstated. */
export interface OpacityEntry {
  declaration: string;
  file: string;
  range: Range;
  sentences: number;
  unprobeable: number;
  skipped: number;
  detail: string[];
}

/** A recurring residue shape: the recurrence bar's evidence, counted mechanically. */
export interface PatternCluster {
  cluster: string;
  pattern: string;
  count: number;
  sites: string[];
}

/** A discovery candidate — report-only; adoption is a human verdict (§8). */
export interface Candidate {
  id: string;
  template: "at-most-one" | "write-once" | "absorbing" | "suspicious-absence" | "bounded-counter";
  status: "theorem" | "near" | "absence";
  claim: string;
  file: string;
  range: Range;
  evidence: string[];
  /** For `near`: the reasoning step the conservative check cannot take. */
  blocked?: string;
}

export interface Question {
  handle: string;
  text: string;
  file: string;
  range: Range;
}

/**
 * One result schema across `check`, `sim`, and `report`: same version, same file list, same
 * diagnostics array; each command fills the arrays it computes and omits the rest, so a consumer
 * parses one shape. `check --json` output is unchanged — the extra arrays are absent there.
 */
export interface CheckResult {
  version: 1;
  files: string[];
  diagnostics: Diagnostic[];
  summary: { errors: number; warnings: number; infos: number };
  verdicts?: Verdict[];
  opacity?: OpacityEntry[];
  patterns?: PatternCluster[];
  candidates?: Candidate[];
  questions?: Question[];
}

export function summarize(diagnostics: Diagnostic[]): CheckResult["summary"] {
  let errors = 0, warnings = 0, infos = 0;
  for (const d of diagnostics) {
    if (d.severity === "error") errors++;
    else if (d.severity === "warning") warnings++;
    else infos++;
  }
  return { errors, warnings, infos };
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Stable order: file, then line, then column, then law — goldens key on this. */
export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) =>
    a.file.localeCompare(b.file) ||
    a.range.start.line - b.range.start.line ||
    a.range.start.col - b.range.start.col ||
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    a.law.localeCompare(b.law) ||
    a.code.localeCompare(b.code));
}
