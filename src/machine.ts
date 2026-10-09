import type { Diagnostic, Verdict } from "./diagnostics";
import type { Expr } from "./cst";
import type { ResolvedModel } from "./resolve";
import { canonicalShape, shapeDecl } from "./store";
import type { ProbeContext, RegionReport } from "./probe";

/**
 * The machine is a projection (§4.4, E45): nothing authored declares a transition. Sources are
 * branch heads and gate refs; edges are authored `->` claims plus landings derived from analyzable
 * effects — both read off the one region survey, so V12's sanity checks are witness-backed. An
 * "unreachable" verdict means a search for a landing firing came back empty, not that a static scan
 * failed to spot one.
 */

export interface MachineEdge {
  from: string;
  to: string;
  kind: "authored" | "derived";
  via: "delta" | "creation";
}

export interface Machine {
  sources: string[];
  edges: MachineEdge[];
}

/** Shapes some firing computably leaves — searched, not inferred from which gate mentions them. */
function exitedShapes(reports: RegionReport[]): Set<string> {
  const out = new Set<string>();
  for (const report of reports) for (const shape of report.departures) out.add(shape);
  return out;
}

function readsToday(expr: Expr | null): boolean {
  if (!expr) return false;
  switch (expr.kind) {
    case "context": return expr.root.text === "today";
    case "binary": return readsToday(expr.left) || readsToday(expr.right);
    case "unary": return readsToday(expr.operand);
    case "paren": return readsToday(expr.inner);
    case "quantified": return readsToday(expr.where);
    default: return false;
  }
}

export function computeMachine(model: ResolvedModel, reports: RegionReport[]): Machine {
  const sources = new Set<string>();
  const edges: MachineEdge[] = [];

  for (const action of model.actionList) {
    for (const condition of action.conditions) if (condition.shape) sources.add(condition.shape.text);
    for (const block of action.actorBlocks) for (const c of block.conditions) if (c.shape) sources.add(c.shape.text);
    for (const branch of action.branches) if (branch.shape) sources.add(branch.shape.text);
  }
  for (const report of reports) {
    for (const outcome of report.firing?.outcomes ?? []) {
      edges.push({ from: report.label, to: canonicalShape(model, outcome.shape), kind: "authored", via: "delta" });
    }
    for (const landing of report.landings) {
      edges.push({ from: report.label, to: canonicalShape(model, landing.shape), kind: "derived", via: landing.via });
    }
  }
  return { sources: [...sources], edges };
}

/** Every shape any declaration points at — an unreferenced shape is check's L-unref-shape, not V12's. */
function referencedShapes(model: ResolvedModel): Set<string> {
  const out = new Set<string>();
  const add = (name: string) => {
    out.add(name);
    const decl = shapeDecl(model, name);
    if (decl) out.add(decl.name.text);
  };
  for (const action of model.actionList) {
    for (const c of action.conditions) if (c.shape) add(c.shape.text);
    for (const b of action.actorBlocks) for (const c of b.conditions) if (c.shape) add(c.shape.text);
    for (const branch of action.branches) if (branch.shape) add(branch.shape.text);
    for (const block of [action.effect, ...action.branches.map(b => b.effect)]) {
      if (!block) continue;
      for (const line of block.lines) if (line.kind === "outcome") add(line.shape.text);
    }
  }
  for (const shape of model.shapeList) if (shape.fuse) add(shape.name.text);
  for (const sc of model.scenarios) {
    for (const w of sc.worlds) for (const ref of w.refs) if (model.shapes.has(ref.text)) add(ref.text);
    for (const step of sc.steps) {
      if (step.expectation?.kind === "shape") add(step.expectation.shape.text);
      for (const ref of step.sentence.refs) if (model.shapes.has(ref.text)) add(ref.text);
    }
    for (const e of sc.expects) for (const s of e.sentences) for (const ref of s.refs) if (model.shapes.has(ref.text)) add(ref.text);
  }
  return out;
}

export function machineDiagnostics(
  ctx: ProbeContext, machine: Machine, reports: RegionReport[], deadShapes: Set<string>,
): { diagnostics: Diagnostic[]; verdicts: Verdict[] } {
  const { model } = ctx;
  const diagnostics: Diagnostic[] = [];
  const verdicts: Verdict[] = [];
  const referenced = referencedShapes(model);
  const reached = new Set(machine.edges.map(e => e.to));
  const exited = exitedShapes(reports);
  const opaqueCount = reports.reduce((n, r) => n + (r.firing?.opaque.length ?? 0), 0);

  for (const shape of model.shapeList) {
    const name = shape.name.text;
    const file = shape.file;
    if (deadShapes.has(name)) {
      diagnostics.push({
        law: "V12", code: "dead-region", severity: "warning",
        message: `\`${name}\` has no satisfying world within scope — an unsatisfiable region is dead vocabulary (V12).`,
        file, range: shape.range, fix: "loosen the predicate, or delete the shape",
      });
      continue;
    }
    if (!referenced.has(name)) continue;                 // unreferenced is L-unref-shape's business
    if (reached.has(name) || (shape.id && reached.has(shape.id.text))) continue;
    if (readsToday(shape.where)) {
      verdicts.push({
        kind: "machine", subject: name, status: "skipped",
        message: "the region is time-varying: its predicate reads `today`, so the clock lights it up without an edge (E51).",
        file, range: shape.range,
      });
      continue;
    }
    diagnostics.push({
      law: "V12", code: "unreachable-shape", severity: "warning",
      message: `no computed edge lands in \`${name}\`: no action's effects move a subject into the region, within scope (V12).`,
      file, range: shape.range,
      fix: "declare the effect that moves a subject into it, or delete the shape",
    });
  }

  // The partiality account for the machine itself: a region nothing computably leaves. Either the
  // region is terminal by design, or its exit is carried by an effect the kernel cannot execute —
  // and the difference is exactly what the operator is being asked to read, not what a tool decides.
  for (const shape of model.shapeList) {
    const name = shape.name.text;
    if (deadShapes.has(name) || !reached.has(name) || exited.has(name)) continue;
    verdicts.push({
      kind: "machine", subject: name, status: "unprobeable",
      message: `edges land in \`${name}\` but none computably leaves it: the region is terminal, or its exit lives in an effect the kernel cannot execute.`,
      file: shape.file, range: shape.range,
      ...(opaqueCount > 0 ? { evidence: [`this model carries ${opaqueCount} opaque effect sentence(s); an exit hiding in one of them would look exactly like this`] } : {}),
    });
  }

  for (const edge of machine.edges) {
    if (edge.kind !== "authored") continue;
    if (machine.edges.some(e => e.from === edge.from && e.to === edge.to && e.kind === "derived")) continue;
    // V2 gates simulation, so an authored edge always lands on a declared shape
    const target = shapeDecl(model, edge.to);
    if (!target) continue;
    verdicts.push({
      kind: "machine", subject: `${edge.from} -> ${edge.to}`, status: "verified",
      message: "authored `->` claim: the outcome is opaque here, so the edge is declared rather than derived (§4.6).",
      file: target.file, range: target.range,
    });
  }
  return { diagnostics, verdicts };
}
