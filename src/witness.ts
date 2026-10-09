import type { Expr } from "./cst";
import type { ResolvedModel } from "./resolve";
import type { Instance, Value, World } from "./eval";
import { addDays, addMonths, durationOf, holds, instanceOf, parseDate, show, unknown } from "./eval";
import { addInstance, BASE_DATE, cloneWorld, context, emptyWorld } from "./store";

/**
 * Small-scope witness search (§8). Dimensions are exhaustive, ints run `0..k`, dates come from a
 * boundary set — the hypothesis being that a predicate with a counterexample has a *small* one.
 *
 * The search cost is controlled by one distinction: members the *required* predicates read get a
 * full domain; members merely written or read elsewhere get a single default value and exist only
 * so a path has something to resolve against. Without it, a Subscription witness would enumerate
 * every axis in the domain to satisfy a predicate that mentions four.
 */

export interface Scope {
  /** Inclusive int ceiling per `Concept.field`. */
  ints: Map<string, number>;
  dates: Value[];
  durations: Value[];
  strings: Value[];
}

const DEFAULT_INT_CEILING = 3;

function walk(expr: Expr | null, visit: (e: Expr) => void): void {
  if (!expr) return;
  visit(expr);
  switch (expr.kind) {
    case "binary": walk(expr.left, visit); walk(expr.right, visit); return;
    case "unary": walk(expr.operand, visit); return;
    case "paren": walk(expr.inner, visit); return;
    case "quantified": walk(expr.where, visit); return;
    default: return;
  }
}

/** Every expression the model authors, with the subject its bare paths resolve against. */
export function* modelExpressions(model: ResolvedModel): Generator<{ expr: Expr; subject: string | null }> {
  for (const shape of model.shapeList) {
    const subject = shape.of?.text ?? null;
    if (shape.where) yield { expr: shape.where, subject };
    if (shape.fuse) yield { expr: shape.fuse.timeout, subject };
  }
  for (const action of model.actionList) {
    const subject = model.subjects.get(action) ?? null;
    for (const c of action.conditions) if (c.expr) yield { expr: c.expr, subject };
    for (const b of action.actorBlocks) for (const c of b.conditions) if (c.expr) yield { expr: c.expr, subject };
    for (const block of [action.effect, ...action.branches.map(b => b.effect)]) {
      if (!block) continue;
      for (const line of block.lines) {
        if (line.kind === "delta") yield { expr: line.expr, subject };
        if (line.kind === "creation") for (const a of line.assignments) yield { expr: a.expr, subject: line.concept.text };
      }
    }
  }
}

/**
 * `k = max(3, largest constant compared against the field + 1)`. `bump` is the probe's escalation:
 * a claim that survives the base scope is re-attacked with a wider one before it is called verified.
 */
export function scopeOf(model: ResolvedModel, bump = 0): Scope {
  const ints = new Map<string, number>();
  const dates: Value[] = [BASE_DATE, parseDate("2026-01-31"), parseDate("2026-02-28"), parseDate("2028-02-29"), parseDate("2026-04-30")];
  const durations: Value[] = [];
  const strings: Value[] = [{ t: "string", s: "" }];

  const noteInt = (key: string, n: number) => ints.set(key, Math.max(ints.get(key) ?? DEFAULT_INT_CEILING, n + 1));

  const fieldKey = (e: Expr, subject: string | null): string | null => {
    if (e.kind !== "path") return null;
    const last = e.segments[e.segments.length - 1];
    const head = e.segments[0];
    if (!last || !head) return null;
    const owner = e.segments.length >= 2 ? e.segments[e.segments.length - 2]?.text : subject;
    return owner ? `${owner}.${last.text}` : null;
  };

  for (const { expr, subject } of modelExpressions(model)) {
    walk(expr, e => {
      if (e.kind === "literal" && e.type === "duration") {
        const d = durationOf(e.token.text);
        if (d.t === "duration" && !durations.some(x => x.t === "duration" && x.months === d.months && x.days === d.days)) durations.push(d);
      }
      if (e.kind === "literal" && e.type === "string" && e.token.value !== "") strings.push({ t: "string", s: e.token.value });
      if (e.kind !== "binary") return;
      const sides: Array<[Expr, Expr]> = [[e.left, e.right], [e.right, e.left]];
      for (const [path, other] of sides) {
        if (other.kind !== "literal" || other.type !== "int") continue;
        const key = fieldKey(path, subject);
        if (key) noteInt(key, Number(other.token.text));
      }
    });
  }
  // Fields compared only against other fields still need room for a delta to move them apart.
  for (const info of model.concepts.values()) {
    for (const [name, field] of info.fields) {
      if (field.type.k !== "int" && field.type.k !== "decimal") continue;
      const key = `${info.decl.name.text}.${name}`;
      ints.set(key, (ints.get(key) ?? DEFAULT_INT_CEILING) + bump);
    }
  }
  if (durations.length === 0) durations.push({ t: "duration", months: 0, days: 1 });
  durations.sort((a, b) => (a.t === "duration" && b.t === "duration" ? (a.months * 31 + a.days) - (b.months * 31 + b.days) : 0));

  // The base date ± every duration in play: a calendar guard like `today = next_billing_date - 1 day`
  // is only satisfiable if the neighbouring day is in the candidate set.
  for (const d of durations.slice(0, 4)) {
    if (d.t !== "duration") continue;
    for (const sign of [1, -1]) {
      const byMonth = addMonths(BASE_DATE, sign * d.months);
      const shifted = byMonth.t === "date" ? addDays(byMonth, sign * d.days) : byMonth;
      if (shifted.t !== "date") continue;
      if (!dates.some(x => x.t === "date" && x.y === shifted.y && x.m === shifted.m && x.d === shifted.d)) dates.push(shifted);
    }
  }
  return { ints, dates, durations, strings };
}

// ---------------------------------------------------------------- skeleton construction

interface Slot { instance: Instance; member: string; domain: Value[] }

/** Concepts a predicate quantifies over, at any depth — each needs instances to quantify across. */
function quantifiedConcepts(exprs: Array<Expr | null>): string[] {
  const out: string[] = [];
  for (const expr of exprs) walk(expr, e => {
    if (e.kind === "quantified" && !out.includes(e.concept.text)) out.push(e.concept.text);
  });
  return out;
}

function memberType(model: ResolvedModel, concept: string, member: string) {
  const info = model.concepts.get(concept);
  if (!info) return null;
  const field = info.fields.get(member);
  if (field) return field.type;
  const dim = info.dimensions.get(member);
  if (dim) return { k: "dim" as const, owner: concept, name: dim.name.text, values: dim.values.map(v => v.text) };
  return null;
}

function domainOf(model: ResolvedModel, scope: Scope, concept: string, member: string, full: boolean): Value[] {
  const type = memberType(model, concept, member);
  if (!type) return [{ t: "word", w: member }];
  const base = type.k === "opt" ? type.inner : type;
  switch (base.k) {
    case "dim": return full ? base.values.map(v => ({ t: "word", w: v } as Value)) : [{ t: "word", w: base.values[0] ?? "unset" }];
    case "int": {
      const ceiling = scope.ints.get(`${concept}.${member}`) ?? DEFAULT_INT_CEILING;
      if (!full) return [{ t: "int", n: 0 }];
      return Array.from({ length: ceiling + 1 }, (_, n) => ({ t: "int", n } as Value));
    }
    case "decimal": return full ? [{ t: "decimal", n: 0 }, { t: "decimal", n: 1 }] : [{ t: "decimal", n: 0 }];
    case "date": return full ? scope.dates : [BASE_DATE];
    case "duration": return full ? scope.durations : [scope.durations[0] ?? { t: "duration", months: 0, days: 1 }];
    case "string": return full ? scope.strings : [{ t: "string", s: "" }];
    case "bool": return full ? [{ t: "bool", b: false }, { t: "bool", b: true }] : [{ t: "bool", b: false }];
    default: return [{ t: "ref", id: null }];
  }
}

/** Create the instance a path segment reaches, so every read in the predicate has a home. */
export function materializePath(model: ResolvedModel, world: World, subject: Instance, segments: string[]): { instance: Instance; member: string } | null {
  let current = subject;
  let start = 1;
  const head = segments[0];
  if (head === undefined) return null;

  if (model.concepts.has(head)) {
    if (head !== subject.concept) {
      const route = model.relationRoute(subject.concept, head);
      if (route === "direct") {
        const link = [...(model.concepts.get(subject.concept)?.fields ?? new Map())]
          .find(([, f]) => f.type.k === "concept" && f.type.name === head);
        if (!link) return null;
        current = linkedInstance(model, world, subject, link[0], head);
      } else if (route === "child") {
        const back = [...(model.concepts.get(head)?.fields ?? new Map())]
          .find(([, f]) => f.type.k === "concept" && f.type.name === subject.concept);
        if (!back) return null;
        const existing = world.instances.find(i => i.concept === head && (i.members.get(back[0]) as { id?: string } | undefined)?.id === subject.id);
        current = existing ?? childInstance(world, head, back[0], subject);
      } else return null;
    }
    if (segments.length === 1) return null;                    // a bare ConceptRef reads no member
  } else {
    start = 0;
  }

  for (let i = start; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (seg === undefined) return null;
    const type = memberType(model, current.concept, seg);
    const base = type?.k === "opt" ? type.inner : type;
    if (!base || base.k !== "concept") return null;
    current = linkedInstance(model, world, current, seg, base.name);
  }
  const member = segments[segments.length - 1];
  return member === undefined ? null : { instance: current, member };
}

function linkedInstance(model: ResolvedModel, world: World, holder: Instance, field: string, concept: string): Instance {
  const existing = holder.members.get(field);
  if (existing && existing.t === "ref" && existing.id) {
    const found = instanceOf(world, existing.id);
    if (found) return found;
  }
  const created = addInstance(world, concept);
  holder.members.set(field, { t: "ref", id: created.id });
  return created;
}

function childInstance(world: World, concept: string, backlink: string, parent: Instance): Instance {
  const created = addInstance(world, concept);
  created.members.set(backlink, { t: "ref", id: parent.id });
  return created;
}

// ---------------------------------------------------------------- the search

export interface WitnessOptions {
  model: ResolvedModel;
  subjectConcept: string | null;
  /** Predicates the world must satisfy. Their members get full domains. */
  require: Array<Expr | null>;
  /** Predicates that must definitely NOT hold — negated gates and first-match branch exclusion. */
  refute?: Array<Expr | null>;
  /** Predicates that constrain nothing but whose members must vary: the falsification frontier. */
  vary?: Array<Expr | null>;
  /** Expressions and paths merely touched: materialized, held at a default value. */
  touch?: Array<Expr | null>;
  paths?: string[][];
  today?: Extract<Value, { t: "date" }>;
  actor?: { id: string; role: string } | null;
  scope?: Scope;
  budget?: number;
  /** Extra pins — replay's `with path = literal` fragments. */
  pins?: Array<{ path: string[]; value: Value }>;
  /** A second acceptance test on the candidate world, e.g. "firing this action falsifies the claim". */
  accept?: (world: World) => boolean;
  /**
   * Survey mode: instead of stopping at the first satisfying world, visit up to `limit` of them.
   * Landing derivation needs the union over several witnesses, not one lucky draw.
   */
  collect?: { limit: number; visit: (world: World) => void };
  /** Cardinalities to try per quantified concept, smallest first. */
  cardinalities?: number[];
}

export interface WitnessOutcome {
  world: World | null;
  /** Assignments examined — reported so "no witness" can be read as scope-bounded, never absolute. */
  searched: number;
  exhausted: boolean;
}

export function witness(options: WitnessOptions): WitnessOutcome {
  const { model, subjectConcept } = options;
  if (subjectConcept === null || !model.concepts.has(subjectConcept)) return { world: null, searched: 0, exhausted: true };

  const scope = options.scope ?? scopeOf(model);
  const budget = options.budget ?? 200_000;
  const cardinalities = options.cardinalities ?? [0, 1, 2];
  const required = options.require.filter((e): e is Expr => e !== null);
  const refuted = (options.refute ?? []).filter((e): e is Expr => e !== null);
  const varied = (options.vary ?? []).filter((e): e is Expr => e !== null);
  const quantified = quantifiedConcepts([...required, ...refuted, ...varied, ...(options.touch ?? [])]);

  let searched = 0;
  let collected = 0;
  let exhausted = true;

  const combos = cardinalityCombos(quantified.length, cardinalities);
  for (const combo of combos) {
    const world = emptyWorld();
    world.today = options.today ?? BASE_DATE;
    world.actor = options.actor ?? null;
    const subject = addInstance(world, subjectConcept);

    for (let i = 0; i < quantified.length; i++) {
      const concept = quantified[i];
      if (concept === undefined || concept === subjectConcept) continue;
      const back = [...(model.concepts.get(concept)?.fields ?? new Map())]
        .find(([, f]) => f.type.k === "concept" && f.type.name === subjectConcept);
      for (let n = 0; n < (combo[i] ?? 0); n++) {
        const created = addInstance(world, concept);
        if (back) created.members.set(back[0], { t: "ref", id: subject.id });
      }
    }

    const slots: Slot[] = [];
    const addSlot = (instance: Instance, member: string, full: boolean) => {
      if (member === "id") return;
      // Relations are structure, not search variables: `materializePath` has already bound them,
      // and handing one a domain would null out the instance the predicate just reached through.
      const type = memberType(model, instance.concept, member);
      // A bare word that names no member is a dimension value, not state: `status = open` reads
      // `open` as a path, and giving it a slot would write a phantom member onto the instance.
      if (type === null) return;
      const base = type.k === "opt" ? type.inner : type;
      if (base.k === "concept") return;
      const existing = slots.find(s => s.instance.id === instance.id && s.member === member);
      if (existing) {
        if (full && existing.domain.length === 1) existing.domain = domainOf(model, scope, instance.concept, member, true);
        return;
      }
      slots.push({ instance, member, domain: domainOf(model, scope, instance.concept, member, full) });
    };

    const collect = (expr: Expr | null, host: Instance, full: boolean): void => {
      if (!expr) return;
      switch (expr.kind) {
        case "path": {
          const target = materializePath(model, world, host, expr.segments.map(s => s.text));
          if (target) addSlot(target.instance, target.member, full);
          return;
        }
        case "quantified": {
          for (const candidate of world.instances.filter(i => i.concept === expr.concept.text)) {
            collect(expr.where, candidate, full);
          }
          return;
        }
        case "binary": collect(expr.left, host, full); collect(expr.right, host, full); return;
        case "unary": collect(expr.operand, host, full); return;
        case "paren": collect(expr.inner, host, full); return;
        default: return;
      }
    };

    for (const expr of required) collect(expr, subject, true);
    for (const expr of refuted) collect(expr, subject, true);
    for (const expr of varied) collect(expr, subject, true);
    for (const expr of options.touch ?? []) collect(expr, subject, false);
    for (const path of options.paths ?? []) {
      const target = materializePath(model, world, subject, path);
      if (target) addSlot(target.instance, target.member, false);
    }
    for (const pin of options.pins ?? []) {
      const target = materializePath(model, world, subject, pin.path);
      if (target) {
        const slot = slots.find(s => s.instance.id === target.instance.id && s.member === target.member);
        if (slot) slot.domain = [pin.value];
        else slots.push({ instance: target.instance, member: target.member, domain: [pin.value] });
      }
    }

    const satisfied = (): boolean => {
      const ctx = context(model, world, subject.id);
      for (const expr of required) if (holds(expr, ctx) !== true) return false;
      // `!== false` and not `=== true`: an undecidable exclusion is not an exclusion.
      for (const expr of refuted) if (holds(expr, ctx) !== false) return false;
      return options.accept ? options.accept(world) : true;
    };

    const indices = new Array<number>(slots.length).fill(0);
    for (;;) {
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (slot) slot.instance.members.set(slot.member, slot.domain[indices[i] ?? 0] ?? unknown("empty domain"));
      }
      searched++;
      if (satisfied()) {
        if (!options.collect) return { world: cloneWorld(world), searched, exhausted: false };
        options.collect.visit(world);
        if (++collected >= options.collect.limit) return { world: null, searched, exhausted: false };
      }
      if (searched >= budget) return { world: null, searched, exhausted: false };

      let carry = slots.length - 1;
      while (carry >= 0) {
        const slot = slots[carry];
        const next = (indices[carry] ?? 0) + 1;
        if (slot && next < slot.domain.length) { indices[carry] = next; break }
        indices[carry] = 0;
        carry--;
      }
      if (carry < 0) break;
    }
  }
  return { world: null, searched, exhausted };
}

function cardinalityCombos(count: number, values: number[]): number[][] {
  if (count === 0) return [[]];
  const out: number[][] = [];
  const indices = new Array<number>(count).fill(0);
  for (;;) {
    out.push(indices.map(i => values[i] ?? 0));
    let carry = count - 1;
    while (carry >= 0) {
      const next = (indices[carry] ?? 0) + 1;
      if (next < values.length) { indices[carry] = next; break }
      indices[carry] = 0;
      carry--;
    }
    if (carry < 0) break;
  }
  // Smallest worlds first: a counterexample with fewer instances is the one worth reporting.
  return out.sort((a, b) => a.reduce((s, n) => s + n, 0) - b.reduce((s, n) => s + n, 0));
}

/** A world rendered as `Instance.member = value` lines — how every counterexample reaches a human. */
export function describeWorld(world: World, subjectId: string | null): string[] {
  const out: string[] = [];
  for (const instance of world.instances) {
    const members = [...instance.members]
      .filter(([, v]) => v.t !== "unknown")
      .map(([k, v]) => `${k} = ${show(v)}`);
    const label = instance.id === subjectId ? `${instance.id} (subject)` : instance.id;
    out.push(members.length > 0 ? `${label}: ${members.join(", ")}` : label);
  }
  out.push(`today = ${show(world.today)}`);
  if (world.actor) out.push(`actor = ${world.actor.role} (${world.actor.id})`);
  return out;
}
