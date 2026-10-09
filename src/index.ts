import type { CheckResult, Diagnostic } from "./diagnostics";
import { sortDiagnostics, summarize } from "./diagnostics";
import type { Domain, RunIndex } from "./domains";
import { load } from "./domains";
import { resolve } from "./resolve";
import { runLaws } from "./laws";

export type { CheckResult, Diagnostic } from "./diagnostics";
export { expand, expandAll, isModelFile } from "./domains";
export type { Expansion } from "./domains";

/** One domain's findings: what its files' structure convicts, then what its laws do. */
export function checkDomain(domain: Domain, index: RunIndex): Diagnostic[] {
  return [...domain.diagnostics, ...runLaws(resolve(domain.model, index))];
}

/** Check model files. Files that share a `domain` header are one model (§1). */
export function check(paths: string[]): CheckResult {
  const run = load(paths);
  const diagnostics: Diagnostic[] = [...run.diagnostics];
  for (const domain of run.domains) diagnostics.push(...checkDomain(domain, run.index));
  const sorted = sortDiagnostics(diagnostics);
  return { version: 1, files: run.files, diagnostics: sorted, summary: summarize(sorted) };
}
