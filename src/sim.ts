import type { CheckResult, Diagnostic, Verdict } from "./diagnostics";
import { sortDiagnostics, summarize } from "./diagnostics";
import { load } from "./domains";
import { resolve } from "./resolve";
import { runLaws } from "./laws";
import { probeActions, probeContext, surveyRegions, witnessShapes } from "./probe";
import { computeMachine, machineDiagnostics } from "./machine";
import { replayScenarios } from "./replay";

/**
 * `meant sim` — witness, probe, replay, and the computed machine, over the same file expansion and
 * the same result schema as `check`. Simulation runs only on a model whose references resolve:
 * a probe over an unresolved shape would report partiality that is really a typo.
 */

/** Stable order for verdicts: file, then position, then claim — goldens and snapshots key on it. */
export function sortVerdicts(verdicts: Verdict[]): Verdict[] {
  return [...verdicts].sort((a, b) =>
    a.file.localeCompare(b.file) ||
    a.range.start.line - b.range.start.line ||
    a.range.start.col - b.range.start.col ||
    a.kind.localeCompare(b.kind) ||
    a.subject.localeCompare(b.subject) ||
    a.message.localeCompare(b.message));
}

export function simulate(paths: string[]): CheckResult {
  const run = load(paths);
  const diagnostics: Diagnostic[] = [...run.diagnostics];
  const verdicts: Verdict[] = [];

  for (const domain of run.domains) {
    const model = resolve(domain.model, run.index);
    const laws = [...domain.diagnostics, ...runLaws(model)];
    diagnostics.push(...laws);
    if (laws.some(d => d.severity === "error")) {
      diagnostics.push({
        law: "V2", code: "sim-skipped", severity: "info",
        message: "simulation skipped: `meant check` must be green before witnesses, probes, and replay mean anything.",
        file: domain.files[0] ?? "", range: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
        fix: "fix the errors above, then re-run `meant sim`",
      });
      continue;
    }

    const ctx = probeContext(model);
    const shapeVerdicts = witnessShapes(ctx);
    verdicts.push(...shapeVerdicts);
    const dead = new Set(shapeVerdicts.filter(v => v.status === "dead").map(v => v.subject));

    const reports = surveyRegions(ctx);
    verdicts.push(...probeActions(ctx, reports));
    verdicts.push(...replayScenarios(ctx));

    const machine = computeMachine(model, reports);
    const sanity = machineDiagnostics(ctx, machine, reports, dead);
    diagnostics.push(...sanity.diagnostics);
    verdicts.push(...sanity.verdicts);
  }

  const sorted = sortDiagnostics(diagnostics);
  return { version: 1, files: run.files, diagnostics: sorted, summary: summarize(sorted), verdicts: sortVerdicts(verdicts) };
}
