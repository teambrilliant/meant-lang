import type { Range, Verdict } from "./diagnostics";
import type { ActionDecl, Branch, Expr, ShapeDecl } from "./cst";
import type { ResolvedModel } from "./resolve";
import type { Instance, World } from "./eval";
import { evaluate, holds } from "./eval";
import { canonicalShape, context, fire, shapeDecl } from "./store";
import { shrinkWorld } from "./shrink";
import { describeWorld, materializePath, scopeOf, witness } from "./witness";
import type { Scope } from "./witness";

/**
 * The falsifier. A probe does not ask "does this claim hold for the witness I happened to find" —
 * it searches for a world in the source region where firing the action makes the claim FALSE.
 * A claim is only called verified after that search comes back empty twice: once at the base scope
 * and once at an escalated one, because a region a delta splits needs witnesses on both sides of
 * the split (the original S001 tick verified against its first witness and was still wrong).
 */

/** How far the scope widens when a claim survives the base search. */
const ESCALATION = 2;

export interface ProbeContext {
  model: ResolvedModel;
  base: Scope;
  wide: Scope;
  budget: number;
}

export const probeContext = (model: ResolvedModel, budget = 60_000): ProbeContext => ({
  model, base: scopeOf(model), wide: scopeOf(model, ESCALATION), budget,
});

export interface Region {
  action: ActionDecl;
  branch: Branch | null;
  label: string;
  require: Array<Expr | null>;
  refute: Array<Expr | null>;
  /** The shapes this region sits inside — the machine reads its out-edges off these. */
  requiredShapes: string[];
  role: string | null;
}

/** The state the action's own gates and this branch's first-match position carve out. */
export function regionsOf(action: ActionDecl, model: ResolvedModel): Region[] {
  const gateRequire: Array<Expr | null> = [];
  const gateRefute: Array<Expr | null> = [];
  const gateShapes: string[] = [];
  for (const condition of action.conditions) {
    if (condition.shape) {
      const decl = shapeDecl(model, condition.shape.text);
      (condition.negated ? gateRefute : gateRequire).push(decl?.where ?? null);
      if (!condition.negated) gateShapes.push(canonicalShape(model, condition.shape.text));
      continue;
    }
    gateRequire.push(condition.expr);
  }
  const role = action.by[0]?.text ?? null;

  if (action.branches.length === 0) {
    return [{ action, branch: null, label: "effect", require: gateRequire, refute: gateRefute, requiredShapes: gateShapes, role }];
  }
  const regions: Region[] = action.branches.map((branch, i) => {
    const refute = [...gateRefute];
    for (let j = 0; j < i; j++) {
      const earlier = action.branches[j]?.shape;
      if (earlier) refute.push(shapeDecl(model, earlier.text)?.where ?? null);
    }
    const require = [...gateRequire];
    const requiredShapes = [...gateShapes];
    if (branch.shape) {
      require.push(shapeDecl(model, branch.shape.text)?.where ?? null);
      requiredShapes.push(canonicalShape(model, branch.shape.text));
    }
    return { action, branch, label: branch.shape?.text ?? "otherwise", require, refute, requiredShapes, role };
  });
  // Without a closing `otherwise`, the action still fires when no branch matches — the universal
  // effect alone. That region is as real as the others and must be probed.
  if (!action.branches.some(b => b.shape === null)) {
    const refute = [...gateRefute];
    for (const branch of action.branches) if (branch.shape) refute.push(shapeDecl(model, branch.shape.text)?.where ?? null);
    regions.push({ action, branch: null, label: "no-branch", require: [...gateRequire], refute, requiredShapes: [...gateShapes], role });
  }
  return regions;
}

/** Expressions and paths a firing touches: materialized so every read resolves, held at defaults. */
function touched(action: ActionDecl, branch: Branch | null): { touch: Array<Expr | null>; paths: string[][] } {
  const touch: Array<Expr | null> = [];
  const paths: string[][] = [];
  for (const block of [branch?.effect ?? null, action.effect]) {
    if (!block) continue;
    for (const line of block.lines) {
      if (line.kind === "delta") { touch.push(line.expr); paths.push(line.path.map(p => p.text)) }
      if (line.kind === "creation") for (const a of line.assignments) touch.push(a.expr);
    }
  }
  for (const b of action.actorBlocks) for (const c of b.conditions) touch.push(c.expr);
  return { touch, paths };
}

/**
 * Bind the actor to the subject's owner. An actor-block gate like `actor.id = customer.id` is a
 * claim about *who*, not about the state space the probe explores; probing as the owner keeps the
 * ownership check honest without turning every state claim into an identity puzzle.
 */
export function bindOwner(action: ActionDecl, model: ResolvedModel, world: World, subjectId: string | null, role: string | null): void {
  if (role === null) { world.actor = null; return }
  world.actor = { id: "actor#1", role };
  for (const block of action.actorBlocks) {
    if (block.actor.text !== role) continue;
    for (const condition of block.conditions) {
      const expr = condition.expr;
      if (!expr || expr.kind !== "binary" || expr.op.text !== "=") continue;
      const sides = [expr.left, expr.right];
      const isActorId = (e: Expr) => e.kind === "context" && e.root.text === "actor" && e.segment?.text === "id";
      const other = isActorId(sides[0] as Expr) ? sides[1] : isActorId(sides[1] as Expr) ? sides[0] : null;
      if (!other) continue;
      let owner = evaluate(other, context(model, world, subjectId));
      if (owner.t === "unknown" && other.kind === "path" && subjectId !== null) {
        // The owner's instance may simply not exist yet in a witness the predicate never reached
        // through. Materialize it: an ownership gate must be decidable before a probe reads it.
        const holder = world.instances.find(i => i.id === subjectId);
        if (holder) {
          materializePath(model, world, holder, other.segments.map(seg => seg.text));
          owner = evaluate(other, context(model, world, subjectId));
        }
      }
      if (owner.t === "id") world.actor = { id: owner.v, role };
      if (owner.t === "ref" && owner.id) world.actor = { id: owner.id, role };
    }
  }
}

export const subjectInstance = (world: World, concept: string): Instance | null =>
  world.instances.find(i => i.concept === concept) ?? null;

/** Shapes over a given concept, in declaration order. */
const shapesOver = (model: ResolvedModel, concept: string): ShapeDecl[] =>
  model.shapeList.filter(s => s.of?.text === concept);

export interface Landing {
  shape: string;
  /** The created instance a landing belongs to, when the edge is a creation rather than a delta. */
  via: "delta" | "creation";
}

/** Members a path expression reads, by leaf name — the join between a predicate and a delta. */
function membersRead(expr: Expr | null, into: Set<string>): void {
  if (!expr) return;
  switch (expr.kind) {
    case "path": { const last = expr.segments[expr.segments.length - 1]; if (last) into.add(last.text); return }
    case "binary": membersRead(expr.left, into); membersRead(expr.right, into); return;
    case "unary": membersRead(expr.operand, into); return;
    case "paren": membersRead(expr.inner, into); return;
    case "quantified": into.add(`~${expr.concept.text}`); membersRead(expr.where, into); return;
    default: return;
  }
}

/** What a region's effects write: delta targets by leaf name, plus the concepts it creates. */
function membersWritten(action: ActionDecl, branch: Branch | null): { members: Set<string>; created: Set<string> } {
  const members = new Set<string>();
  const created = new Set<string>();
  for (const block of [branch?.effect ?? null, action.effect]) {
    if (!block) continue;
    for (const line of block.lines) {
      if (line.kind === "delta") { const last = line.path[line.path.length - 1]; if (last) members.add(last.text) }
      if (line.kind === "creation") { created.add(line.concept.text); members.add(`~${line.concept.text}`) }
    }
  }
  return { members, created };
}

/** Regions the firing moved into: true after, not true before (§8's derived landings). */
export function landings(model: ResolvedModel, before: World, after: World, subject: Instance): Landing[] {
  const out: Landing[] = [];
  for (const shape of shapesOver(model, subject.concept)) {
    const post = holds(shape.where, context(model, after, subject.id));
    const pre = holds(shape.where, context(model, before, subject.id));
    if (post === true && pre !== true) out.push({ shape: shape.name.text, via: "delta" });
  }
  return out;
}

export function creationLandings(model: ResolvedModel, after: World, created: Array<{ concept: string; id: string }>): Landing[] {
  const out: Landing[] = [];
  for (const instance of created) {
    for (const shape of shapesOver(model, instance.concept)) {
      if (holds(shape.where, context(model, after, instance.id)) === true) out.push({ shape: shape.name.text, via: "creation" });
    }
  }
  return out;
}

interface Firing {
  before: World;
  after: World;
  subject: Instance;
  opaque: Array<{ text: string; range: Range }>;
  outcomes: Array<{ shape: string; range: Range }>;
  created: Array<{ concept: string; id: string }>;
  denied: string | null;
  undecided: string | null;
  landings: Landing[];
}

export function runFiring(region: Region, model: ResolvedModel, world: World, subjectConcept: string): Firing | null {
  const subject = subjectInstance(world, subjectConcept);
  if (!subject) return null;
  bindOwner(region.action, model, world, subject.id, region.role);
  const fired = fire(region.action, model, world, subject.id, region.role);
  const after = fired.world;
  return {
    before: world,
    after,
    subject,
    opaque: fired.opaque,
    outcomes: fired.outcomes,
    created: fired.created,
    denied: fired.denied?.code ?? null,
    undecided: fired.undecided,
    landings: [...landings(model, world, after, subject), ...creationLandings(model, after, fired.created)],
  };
}

/**
 * One pass over every region: a representative firing (for opaque effects, denials, and authored
 * claims) plus a *targeted* search per candidate landing. Targeted, not sampled — a landing that
 * needs one particular value hides from any fixed sample, and calling a region "no edge" on that
 * basis would be an accusation the search never earned.
 *
 * Both the probe verdicts and the machine projection read this one report, so the searches are
 * paid for once.
 */
export interface RegionReport {
  region: Region;
  label: string;
  subjectConcept: string;
  seed: World | null;
  searched: number;
  firing: Firing | null;
  landings: Landing[];
  /** Regions this firing leaves: true before, not true after — the machine's out-edges. */
  departures: string[];
  touch: Array<Expr | null>;
  paths: string[][];
}

export function surveyRegions(ctx: ProbeContext): RegionReport[] {
  const { model } = ctx;
  const out: RegionReport[] = [];
  for (const action of model.actionList) {
    const subjectConcept = model.subjects.get(action) ?? null;
    if (subjectConcept === null) continue;
    for (const region of regionsOf(action, model)) {
      const { touch, paths } = touched(action, region.branch);
      const label = `${action.id?.text ?? action.name.text}@${region.label}`;
      const seed = witness({
        model, subjectConcept, require: region.require, refute: region.refute,
        touch, paths, scope: ctx.base, budget: ctx.budget,
      });
      const firing = seed.world ? runFiring(region, model, seed.world, subjectConcept) : null;
      const edges = seed.world
        ? searchEdges(ctx, region, subjectConcept, touch, paths)
        : { landings: [], departures: [] };
      out.push({
        region, label, subjectConcept, seed: seed.world, searched: seed.searched, firing,
        landings: edges.landings, departures: edges.departures, touch, paths,
      });
    }
  }
  return out;
}

/**
 * A landing needs the effects to move something the target reads, so only shapes reading a written
 * member are candidates — the pruning that keeps this affordable on a domain with five axes.
 */
function searchEdges(
  ctx: ProbeContext, region: Region, subjectConcept: string,
  touch: Array<Expr | null>, paths: string[][],
): { landings: Landing[]; departures: string[] } {
  const { model } = ctx;
  const written = membersWritten(region.action, region.branch);
  const reachesQuantifier = (shape: ShapeDecl): boolean => {
    const reads = new Set<string>();
    membersRead(shape.where, reads);
    return [...reads].some(r => written.members.has(r));
  };
  const out: Landing[] = [];
  const departures: string[] = [];

  for (const shape of shapesOver(model, subjectConcept)) {
    if (!reachesQuantifier(shape)) continue;
    // One search per direction: a landing is post-true/pre-false, a departure the mirror image.
    // Both are needed — the machine that only knows how regions are entered cannot say which of
    // them a model can never leave, which is the question partiality is actually about.
    const crosses = (into: boolean) => (world: World): boolean => {
      const firing = runFiring(region, model, world, subjectConcept);
      if (!firing || firing.denied !== null) return false;
      const post = holds(shape.where, context(model, firing.after, firing.subject.id));
      const pre = holds(shape.where, context(model, world, firing.subject.id));
      return into ? post === true && pre !== true : pre === true && post === false;
    };
    for (const into of [true, false]) {
      const found = witness({
        model, subjectConcept, require: region.require, refute: region.refute,
        vary: [shape.where], touch, paths, scope: ctx.base, budget: ctx.budget, accept: crosses(into),
      });
      if (!found.world) continue;
      if (into) out.push({ shape: shape.name.text, via: "delta" });
      else departures.push(shape.name.text);
    }
  }

  for (const concept of written.created) {
    for (const shape of shapesOver(model, concept)) {
      const lands = (world: World): boolean => {
        const firing = runFiring(region, model, world, subjectConcept);
        if (!firing || firing.denied !== null) return false;
        return firing.created.some(c => c.concept === concept
          && holds(shape.where, context(model, firing.after, c.id)) === true);
      };
      const found = witness({
        model, subjectConcept, require: region.require, refute: region.refute,
        vary: [shape.where], touch, paths, scope: ctx.base, budget: ctx.budget, accept: lands,
      });
      if (found.world && !out.some(l => l.shape === shape.name.text)) out.push({ shape: shape.name.text, via: "creation" });
    }
  }
  return { landings: out, departures };
}

export function probeActions(ctx: ProbeContext, reports: RegionReport[]): Verdict[] {
  const { model } = ctx;
  const out: Verdict[] = [];

  for (const action of model.actionList) {
    if ((model.subjects.get(action) ?? null) === null) {
      out.push({
        kind: "probe", subject: action.name.text, status: "skipped",
        message: "no determinable subject — V9 must pass before this action can be probed.",
        file: action.file, range: action.range,
      });
    }
  }

  for (const report of reports) {
    const { region, label, firing } = report;
    const action = region.action;
    const file = action.file;
    const at = region.branch?.range ?? action.range;

    if (!report.seed) {
      out.push({
        kind: "probe", subject: label, status: "dead",
        message: `no world satisfies this region's gates within scope (${report.searched} assignments examined) — the branch is unreachable as declared.`,
        file, range: at,
      });
      continue;
    }
    if (!firing) continue;
    if (firing.denied !== null) {
      out.push({
        kind: "probe", subject: label, status: "unprobeable",
        message: `every witness of this region is denied \`${firing.denied}\` — the gates and the branch disagree.`,
        file, range: at,
        counterexample: describeWorld(report.seed, firing.subject.id),
      });
      continue;
    }
    if (firing.undecided !== null) {
      out.push({
        kind: "probe", subject: label, status: "unprobeable",
        message: `${firing.undecided} — the firing cannot be decided, so nothing downstream of it is claimed.`,
        file, range: at,
      });
      continue;
    }

    for (const line of firing.opaque) {
      out.push({
        kind: "probe", subject: label, status: "unprobeable",
        message: `effect sentence carries meaning the kernel cannot execute: "${line.text}".`,
        file, range: line.range,
      });
    }

    for (const outcome of firing.outcomes) {
      out.push(probeClaim(ctx, region, report.subjectConcept, outcome, report.touch, report.paths));
    }

    for (const landing of report.landings) {
      const evidence: string[] = [];
      if (firing.outcomes.some(o => canonicalShape(model, o.shape) === canonicalShape(model, landing.shape))) {
        evidence.push(`\`-> ${landing.shape}\` is also authored here — a computed fact should not be written down (design law 2)`);
      }
      if (firing.opaque.length > 0) {
        evidence.push(`this branch also carries ${firing.opaque.length} opaque effect sentence(s): the landing derives, the rest does not`);
      }
      out.push({
        kind: "probe", subject: `${label} -> ${landing.shape}`, status: "derived",
        message: landing.via === "creation"
          ? `the creation lands a new instance in \`${landing.shape}\` — authored nowhere, and correctly so (§4.6).`
          : `the deltas land in \`${landing.shape}\` — authored nowhere, and correctly so (§4.6).`,
        file, range: at,
        ...(evidence.length > 0 ? { evidence } : {}),
      });
    }
  }
  return out;
}

/** One authored `-> Shape`, attacked at the base scope and then at the escalated one. */
function probeClaim(
  ctx: ProbeContext, region: Region, subjectConcept: string,
  outcome: { shape: string; range: Range },
  touch: Array<Expr | null>, paths: string[][],
): Verdict {
  const { model } = ctx;
  const file = region.action.file;
  const target = shapeDecl(model, outcome.shape);
  const subject = `${region.action.id?.text ?? region.action.name.text}:${outcome.shape}`;
  if (!target) {
    return {
      kind: "probe", subject, status: "unprobeable",
      message: `\`${outcome.shape}\` is not a declared shape — V2 must pass first.`, file, range: outcome.range,
    };
  }

  let unknownSeen = false;
  const falsifies = (world: World): boolean => {
    const firing = runFiring(region, model, world, subjectConcept);
    if (!firing || firing.denied !== null) return false;
    const verdict = holds(target.where, context(model, firing.after, firing.subject.id));
    if (verdict === null) { unknownSeen = true; return false }
    return verdict === false;
  };

  for (const scope of [ctx.base, ctx.wide]) {
    const found = witness({
      model, subjectConcept, require: region.require, refute: region.refute,
      vary: [target.where], touch, paths, scope, budget: ctx.budget, accept: falsifies,
    });
    if (!found.world) continue;
    const subjectId = subjectInstance(found.world, subjectConcept)?.id ?? null;
    const minimal = shrinkWorld(found.world, model, subjectId, w => {
      const ctxW = context(model, w, subjectId);
      for (const expr of region.require) if (expr && holds(expr, ctxW) !== true) return false;
      for (const expr of region.refute) if (expr && holds(expr, ctxW) !== false) return false;
      return falsifies(w);
    });
    return {
      kind: "probe", subject, status: "falsified",
      message: `firing \`${region.action.name.text}\` from this region does not land in \`${outcome.shape}\`.`,
      file, range: outcome.range,
      counterexample: describeWorld(minimal, subjectInstance(minimal, subjectConcept)?.id ?? null),
    };
  }

  if (unknownSeen) {
    return {
      kind: "probe", subject, status: "unprobeable",
      message: `\`${outcome.shape}\`'s predicate reads state this firing leaves unset — the claim cannot be decided.`,
      file, range: outcome.range,
    };
  }
  return {
    kind: "probe", subject, status: "verified",
    message: `no counterexample within scope: every witness of this region lands in \`${outcome.shape}\`.`,
    file, range: outcome.range,
    evidence: [`searched the base scope and an escalated one (int ceilings +${ESCALATION})`],
  };
}

// ---------------------------------------------------------------- witnesses (AC3)

export function witnessShapes(ctx: ProbeContext): Verdict[] {
  const { model } = ctx;
  const out: Verdict[] = [];
  for (const shape of model.shapeList) {
    const file = shape.file;
    const subjectConcept = shape.of?.text ?? null;
    if (subjectConcept === null) {
      out.push({
        kind: "witness", subject: shape.name.text, status: "skipped",
        message: "the shape pins no subject with `of`, so there is no state space to search.",
        file, range: shape.range,
      });
      continue;
    }
    const found = witness({ model, subjectConcept, require: [shape.where], scope: ctx.base, budget: ctx.budget });
    if (found.world) {
      const subjectId = subjectInstance(found.world, subjectConcept)?.id ?? null;
      const minimal = shrinkWorld(found.world, model, subjectId, w => holds(shape.where, context(model, w, subjectId)) === true);
      out.push({
        kind: "witness", subject: shape.name.text, status: "verified",
        message: `satisfiable — one concrete world lights this region up.`,
        file, range: shape.range,
        counterexample: describeWorld(minimal, subjectId),
      });
      continue;
    }
    out.push({
      kind: "witness", subject: shape.name.text, status: "dead",
      message: `no world satisfies \`where\` within scope (${found.searched} assignments examined): dead vocabulary.`,
      file, range: shape.range,
    });
  }
  return out;
}
