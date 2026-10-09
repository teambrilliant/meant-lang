import type { Range } from "./diagnostics";
import { joinTokens } from "./lexer";
import type { ActionDecl, Branch, Condition, EffectBlock, ShapeDecl } from "./cst";
import { exprText } from "./cst";
import type { ResolvedModel } from "./resolve";
import type { EvalContext, Instance, Value, World } from "./eval";
import { addDays, addMonths, date, evaluate, holds, instanceOf, readPath, unknown } from "./eval";

/**
 * Worlds and what firing an action does to one. The store owns the three things the evaluator
 * deliberately does not: instance identity, the first-match branch decision, and effect
 * application. Every operation is pure — a firing returns a new world, so a probe can re-seed and
 * re-fire without a reset protocol.
 */

/** The base date for witness search and unpinned replays: a mid-month day, so ± a month is unclamped. */
export const BASE_DATE = date(2026, 3, 15) as Extract<Value, { t: "date" }>;

export const emptyWorld = (): World => ({ instances: [], today: BASE_DATE, actor: null });

export function cloneWorld(world: World): World {
  return {
    instances: world.instances.map(i => ({ id: i.id, concept: i.concept, members: new Map(i.members) })),
    today: world.today,
    actor: world.actor ? { ...world.actor } : null,
  };
}

/** Ids are `Concept#n`, numbered per concept in creation order — stable across identical runs. */
export function addInstance(world: World, concept: string): Instance {
  const n = world.instances.filter(i => i.concept === concept).length + 1;
  const instance: Instance = { id: `${concept}#${n}`, concept, members: new Map() };
  world.instances.push(instance);
  return instance;
}

export const shapeDecl = (model: ResolvedModel, name: string): ShapeDecl | null => model.shapes.get(name) ?? null;

/** A shape ref resolved to its declared Name: `S002` and `InstallmentLastOfCycle` are one region. */
export const canonicalShape = (model: ResolvedModel, ref: string): string => shapeDecl(model, ref)?.name.text ?? ref;

/** The concept a shape predicates over — `of`, or nothing for a subjectless shape. */
export const shapeSubject = (model: ResolvedModel, name: string): string | null =>
  shapeDecl(model, name)?.of?.text ?? null;

export function context(model: ResolvedModel, world: World, subject: string | null): EvalContext {
  return { model, world, subject, outer: null };
}

/** Does the subject satisfy this shape's region right now? `null` = undecidable in this world. */
export function inShape(model: ResolvedModel, world: World, subject: string | null, name: string): boolean | null {
  const decl = shapeDecl(model, name);
  if (!decl) return null;
  return holds(decl.where, context(model, world, subject));
}

// ---------------------------------------------------------------- effects

export interface Denial { code: string; reason: string; range: Range }

export interface Fired {
  world: World;
  denied: Denial | null;
  /** A role invoked an action with no `by` list: deny-by-default says it cannot (E33/§4.6). */
  admissionMismatch: string | null;
  branch: string | null;
  /** A gate or branch the world could not decide — never the same thing as "fired cleanly". */
  undecided: string | null;
  /** Effect content the kernel cannot execute — the partiality account, never silent. */
  opaque: Array<{ text: string; range: Range }>;
  outcomes: Array<{ shape: string; range: Range }>;
  created: Array<{ concept: string; id: string }>;
  /** Deltas whose target or value could not be resolved in this world. */
  unresolved: string[];
}

function targetOf(segments: string[], ctx: EvalContext): { instance: Instance; member: string } | null {
  const member = segments[segments.length - 1];
  if (member === undefined) return null;
  if (segments.length === 1) {
    const subject = instanceOf(ctx.world, ctx.subject);
    return subject ? { instance: subject, member } : null;
  }
  const holder = readPath(segments.slice(0, -1), ctx);
  if (holder.t !== "ref" || holder.id === null) return null;
  const instance = instanceOf(ctx.world, holder.id);
  return instance ? { instance, member } : null;
}

function applyDelta(op: string, current: Value, value: Value): Value {
  if (op === "=") return value;
  if (current.t === "unknown") return current;
  if (value.t === "unknown") return value;
  const sign = op === "+=" ? 1 : -1;
  if ((current.t === "int" || current.t === "decimal") && (value.t === "int" || value.t === "decimal")) {
    const n = current.n + sign * value.n;
    return current.t === "int" && value.t === "int" ? { t: "int", n } : { t: "decimal", n };
  }
  if (current.t === "date" && value.t === "duration") {
    const byMonth = addMonths(current, sign * value.months);
    return byMonth.t === "date" ? addDays(byMonth, sign * value.days) : byMonth;
  }
  if (current.t === "duration" && value.t === "duration") {
    return { t: "duration", months: current.months + sign * value.months, days: current.days + sign * value.days };
  }
  return unknown(`\`${op}\` does not apply to ${current.t} and ${value.t}`);
}

/**
 * Effect lines run in order, each seeing the writes before it — the sequential reading of §4.6's
 * postcondition block. (The spec does not pin the order; sequential is the narrower reading, since
 * simultaneous assignment would make `n = n + 1` mean something the text never says.)
 */
function applyBlock(block: EffectBlock, model: ResolvedModel, world: World, subject: string | null, out: Fired): void {
  for (const line of block.lines) {
    const ctx = context(model, world, subject);
    if (line.kind === "sentence") {
      const text = joinTokens(line.sentence.tokens);
      if (text.trim() !== "") out.opaque.push({ text, range: line.range });
      continue;
    }
    if (line.kind === "outcome") { out.outcomes.push({ shape: line.shape.text, range: line.range }); continue }
    if (line.kind === "delta") {
      const value = evaluate(line.expr, ctx);
      const target = targetOf(line.path.map(p => p.text), ctx);
      if (!target) { out.unresolved.push(`${line.path.map(p => p.text).join(".")} has no target in this world`); continue }
      const current = target.instance.members.get(target.member) ?? unknown("unset");
      const next = applyDelta(line.op.text, current, value);
      if (next.t === "unknown" && line.op.text !== "=") out.unresolved.push(`${line.path.map(p => p.text).join(".")}: ${next.why}`);
      target.instance.members.set(target.member, next);
      continue;
    }
    // creation (E49): the created instance's unique subject-typed relation auto-binds to the actor's subject
    const created = addInstance(world, line.concept.text);
    out.created.push({ concept: line.concept.text, id: created.id });
    const info = model.concepts.get(line.concept.text);
    const holder = instanceOf(world, subject);
    if (info && holder) {
      const links = [...info.fields].filter(([, f]) => f.type.k === "concept" && f.type.name === holder.concept);
      const only = links.length === 1 ? links[0] : undefined;
      if (only) created.members.set(only[0], { t: "ref", id: holder.id });
    }
    for (const assignment of line.assignments) {
      created.members.set(assignment.name.text, evaluate(assignment.expr, ctx));
    }
  }
}

// ---------------------------------------------------------------- gates

export interface GateVerdict { denied: Denial | null; undecided: string | null }

function conditionLabel(condition: Condition): string {
  if (condition.shape) return `${condition.negated ? "not " : ""}${condition.shape.text}`;
  return exprText(condition.expr);
}

function checkCondition(condition: Condition, model: ResolvedModel, world: World, subject: string | null): boolean | null {
  if (condition.shape) {
    const held = inShape(model, world, subject, condition.shape.text);
    return held === null ? null : condition.negated ? !held : held;
  }
  return holds(condition.expr, context(model, world, subject));
}

export function gate(action: ActionDecl, model: ResolvedModel, world: World, subject: string | null, role: string | null): GateVerdict {
  const admitted = action.by.map(b => b.text);
  if (admitted.length > 0 && (role === null || !admitted.includes(role))) {
    return {
      denied: { code: "FORBIDDEN", reason: `${role ?? "a system firing"} is not in this action's admission list`, range: action.range },
      undecided: null,
    };
  }
  const conditions: Condition[] = [...action.conditions];
  for (const block of action.actorBlocks) if (role !== null && block.actor.text === role) conditions.push(...block.conditions);
  for (const condition of conditions) {
    const held = checkCondition(condition, model, world, subject);
    if (held === null) return { denied: null, undecided: conditionLabel(condition) };
    if (!held) {
      return {
        denied: { code: condition.elseCode?.text ?? "FORBIDDEN", reason: `\`${conditionLabel(condition)}\` does not hold`, range: condition.range },
        undecided: null,
      };
    }
  }
  return { denied: null, undecided: null };
}

/** First-match, top-down (§4.6). `null` branch means the region cannot be decided in this world. */
export function selectBranch(action: ActionDecl, model: ResolvedModel, world: World, subject: string | null):
  { branch: Branch | null; undecided: string | null } {
  for (const branch of action.branches) {
    if (branch.shape === null) return { branch, undecided: null };
    const held = inShape(model, world, subject, branch.shape.text);
    if (held === null) return { branch: null, undecided: branch.shape.text };
    if (held) return { branch, undecided: null };
  }
  return { branch: null, undecided: null };
}

/**
 * Fire an action against a world. The world is cloned first, so the caller keeps its pre-state —
 * probes need both sides of the transition to report a counterexample.
 */
export function fire(
  action: ActionDecl, model: ResolvedModel, before: World, subject: string | null, role: string | null,
): Fired {
  const world = cloneWorld(before);
  world.actor = role === null ? null : { id: world.actor?.id ?? "actor#1", role };
  const out: Fired = {
    world, denied: null, admissionMismatch: null, branch: null, undecided: null,
    opaque: [], outcomes: [], created: [], unresolved: [],
  };

  if (action.by.length === 0 && role !== null) {
    out.admissionMismatch = `\`${action.name.text}\` declares no \`by\` list — it is system-triggered, so ${role} cannot invoke it (§4.6)`;
  }

  const verdict = gate(action, model, world, subject, role);
  if (verdict.denied) { out.denied = verdict.denied; return out }
  if (verdict.undecided) { out.undecided = `gate \`${verdict.undecided}\` is undecidable in this world`; return out }

  const selected = selectBranch(action, model, world, subject);
  if (selected.undecided) { out.undecided = `branch \`in ${selected.undecided}\` is undecidable in this world`; return out }
  if (selected.branch) {
    out.branch = selected.branch.shape?.text ?? "otherwise";
    if (selected.branch.effect) applyBlock(selected.branch.effect, model, world, subject, out);
  }
  if (action.effect) applyBlock(action.effect, model, world, subject, out);
  return out;
}
