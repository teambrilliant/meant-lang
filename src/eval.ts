import type { Expr } from "./cst";
import type { ResolvedModel } from "./resolve";

/**
 * The total interpreter for §3. Every expression terminates: no loops, no recursion, no user
 * functions. Partiality is a *value*, not an exception — `unknown` propagates so that an opaque
 * effect degrades one claim to unprobeable instead of aborting a run.
 */
export type Value =
  | { t: "int"; n: number }
  | { t: "decimal"; n: number }
  | { t: "string"; s: string }
  | { t: "bool"; b: boolean }
  | { t: "date"; y: number; m: number; d: number }
  | { t: "duration"; months: number; days: number }
  | { t: "word"; w: string }                 // a dimension value or a `values` entry name
  | { t: "ref"; id: string | null }          // an instance, or an unset optional relation
  | { t: "id"; v: string }                   // the kernel identity accessor's result
  | { t: "unknown"; why: string };

export const unknown = (why: string): Value => ({ t: "unknown", why });

export interface Instance {
  id: string;
  concept: string;
  members: Map<string, Value>;
}

export interface World {
  instances: Instance[];
  today: Extract<Value, { t: "date" }>;
  /** Who acts. `null` is a system firing — the absence of `by`, never a role named `system` (E33). */
  actor: { id: string; role: string } | null;
}

// ---------------------------------------------------------------- calendar (E22 is kernel semantics)

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export function daysInMonth(y: number, m: number): number {
  return m === 2 ? (isLeap(y) ? 29 : 28) : (MONTH_DAYS[m - 1] ?? 30);
}

/** Proleptic Gregorian days since 1970-01-01 (Hinnant's civil algorithms). */
export function toDayNumber(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function fromDayNumber(n: number): { y: number; m: number; d: number } {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

export const date = (y: number, m: number, d: number): Value => ({ t: "date", y, m, d });

export function addDays(v: Extract<Value, { t: "date" }>, days: number): Value {
  const { y, m, d } = fromDayNumber(toDayNumber(v.y, v.m, v.d) + days);
  return date(y, m, d);
}

/** `date ± N months` clamps to month end — there is nowhere else for Feb 30 to go (E22). */
export function addMonths(v: Extract<Value, { t: "date" }>, months: number): Value {
  const total = v.y * 12 + (v.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  return date(y, m, Math.min(v.d, daysInMonth(y, m)));
}

const shiftDate = (v: Extract<Value, { t: "date" }>, dur: Extract<Value, { t: "duration" }>, sign: number): Value => {
  const byMonth = addMonths(v, sign * dur.months);
  return byMonth.t === "date" ? addDays(byMonth, sign * dur.days) : byMonth;
};

/** §3 units. Sub-day units floor to zero days: v0 refuses time-of-day (§13), `today` is date-resolution. */
export function durationOf(text: string): Value {
  const m = /^(\d+)\s*([a-z]+)$/.exec(text.trim());
  if (!m) return unknown(`\`${text}\` is not a duration literal`);
  const n = Number(m[1]);
  switch ((m[2] ?? "").replace(/s$/, "")) {
    case "year": return { t: "duration", months: n * 12, days: 0 };
    case "month": return { t: "duration", months: n, days: 0 };
    case "week": return { t: "duration", months: 0, days: n * 7 };
    case "day": case "d": return { t: "duration", months: 0, days: n };
    case "hour": case "h": case "minute": case "m": case "second": case "s": case "ms":
      return { t: "duration", months: 0, days: 0 };
    default: return unknown(`\`${text}\` carries no §3 unit`);
  }
}

export function parseDate(text: string): Value {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return unknown(`"${text}" is not an ISO date`);
  return date(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function show(v: Value): string {
  switch (v.t) {
    case "int": case "decimal": return String(v.n);
    case "string": return JSON.stringify(v.s);
    case "bool": return String(v.b);
    case "date": return `${v.y}-${String(v.m).padStart(2, "0")}-${String(v.d).padStart(2, "0")}`;
    case "duration": return [v.months ? `${v.months} months` : "", v.days ? `${v.days} days` : ""].filter(Boolean).join(" + ") || "0 days";
    case "word": return v.w;
    case "ref": return v.id ?? "none";
    case "id": return v.v;
    case "unknown": return "?";
  }
}

// ---------------------------------------------------------------- evaluation

export interface EvalContext {
  model: ResolvedModel;
  world: World;
  /** The instance the bare paths resolve against — the shape's `of` or the action's subject. */
  subject: string | null;
  /** `this` inside a quantifier body: the subject of the enclosing evaluation. */
  outer: string | null;
}

export const instanceOf = (world: World, id: string | null): Instance | null =>
  id === null ? null : world.instances.find(i => i.id === id) ?? null;

const numeric = (v: Value): v is Extract<Value, { t: "int" | "decimal" }> => v.t === "int" || v.t === "decimal";

function compare(op: string, left: Value, right: Value): Value {
  if (left.t === "unknown") return left;
  if (right.t === "unknown") return right;

  const ordered = (a: number, b: number): Value => ({
    t: "bool",
    b: op === "=" ? a === b : op === "!=" ? a !== b : op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b,
  });

  if (numeric(left) && numeric(right)) return ordered(left.n, right.n);
  if (left.t === "date" && right.t === "date") {
    return ordered(toDayNumber(left.y, left.m, left.d), toDayNumber(right.y, right.m, right.d));
  }
  if (left.t === "duration" && right.t === "duration") {
    if (left.months === 0 && right.months === 0) return ordered(left.days, right.days);
    if (left.days === 0 && right.days === 0) return ordered(left.months, right.months);
    return unknown("durations mixing months and days are not ordered without a calendar anchor");
  }
  if (op !== "=" && op !== "!=") return unknown(`\`${op}\` does not order ${left.t} and ${right.t}`);

  const same =
    left.t === "string" && right.t === "string" ? left.s === right.s
      : left.t === "bool" && right.t === "bool" ? left.b === right.b
        : left.t === "word" && right.t === "word" ? left.w === right.w
          : left.t === "ref" && right.t === "ref" ? left.id === right.id
            : left.t === "id" && right.t === "id" ? left.v === right.v
              : left.t === "ref" && right.t === "id" ? left.id === right.v
                : left.t === "id" && right.t === "ref" ? left.v === right.id
                  : null;
  if (same === null) return unknown(`${left.t} and ${right.t} are not comparable`);
  return { t: "bool", b: op === "=" ? same : !same };
}

function arithmetic(op: string, left: Value, right: Value): Value {
  if (left.t === "unknown") return left;
  if (right.t === "unknown") return right;
  if (left.t === "date" && right.t === "duration") {
    if (op === "+") return shiftDate(left, right, 1);
    if (op === "-") return shiftDate(left, right, -1);
  }
  if (left.t === "date" && right.t === "date" && op === "-") {
    return { t: "duration", months: 0, days: toDayNumber(left.y, left.m, left.d) - toDayNumber(right.y, right.m, right.d) };
  }
  if (left.t === "duration" && right.t === "duration" && (op === "+" || op === "-")) {
    const sign = op === "+" ? 1 : -1;
    return { t: "duration", months: left.months + sign * right.months, days: left.days + sign * right.days };
  }
  if (numeric(left) && numeric(right)) {
    if (op === "/" && right.n === 0) return unknown("division by zero");
    const n = op === "+" ? left.n + right.n : op === "-" ? left.n - right.n : op === "*" ? left.n * right.n : left.n / right.n;
    const int = left.t === "int" && right.t === "int" && op !== "/";
    return int ? { t: "int", n } : { t: "decimal", n };
  }
  return unknown(`\`${op}\` does not apply to ${left.t} and ${right.t}`);
}

/** Read one member off an instance; `.id` is the kernel identity accessor (§3). */
export function readMember(instance: Instance, member: string): Value {
  if (member === "id") return { t: "id", v: instance.id };
  return instance.members.get(member) ?? unknown(`${instance.concept}.${member} is unset in this world`);
}

/**
 * Walk a path from the subject. A Capitalized root routes through the unique relation (E31); a
 * child-side route resolves only when exactly one related instance exists — zero or several is
 * `unknown`, never a silent pick.
 */
export function readPath(segments: string[], ctx: EvalContext): Value {
  const head = segments[0];
  if (head === undefined) return unknown("empty path");
  const subject = instanceOf(ctx.world, ctx.subject);

  let current: Instance | null = null;
  let start = 1;

  if (ctx.model.concepts.has(head)) {
    if (subject && subject.concept === head) current = subject;
    else if (subject) {
      const route = ctx.model.relationRoute(subject.concept, head);
      if (route === "direct") {
        const field = [...(ctx.model.concepts.get(subject.concept)?.fields ?? new Map())]
          .find(([, f]) => f.type.k === "concept" && f.type.name === head);
        const value = field ? readMember(subject, field[0]) : unknown(`no ${head} relation`);
        if (value.t !== "ref") return value.t === "unknown" ? value : unknown(`${head} is not a relation`);
        current = instanceOf(ctx.world, value.id);
        if (!current) return unknown(`no ${head} instance is bound in this world`);
      } else if (route === "child") {
        const backlink = [...(ctx.model.concepts.get(head)?.fields ?? new Map())]
          .find(([, f]) => f.type.k === "concept" && f.type.name === subject.concept);
        const related = ctx.world.instances.filter(i =>
          i.concept === head && backlink !== undefined && (i.members.get(backlink[0]) ?? { t: "ref", id: null }).t === "ref"
          && (i.members.get(backlink[0]) as { t: "ref"; id: string | null }).id === subject.id);
        if (related.length !== 1) return unknown(`${related.length} ${head} instances relate to this ${subject.concept}; a concept-rooted read needs exactly one`);
        current = related[0] ?? null;
      } else return unknown(`${subject.concept} has no unique relation to ${head}`);
    } else return unknown(`no subject to route ${head} through`);
    if (segments.length === 1) return current ? { t: "ref", id: current.id } : unknown(`no ${head}`);
  } else {
    if (!subject) return unknown(`\`${head}\` has no subject to resolve against`);
    const info = ctx.model.concepts.get(subject.concept);
    if (!info?.fields.has(head) && !info?.dimensions.has(head)) {
      // A bare word that resolves to no member is a dimension value or a `values` entry name.
      return segments.length === 1 ? { t: "word", w: head } : unknown(`\`${head}\` is not a member of ${subject.concept}`);
    }
    current = subject;
    start = 0;
  }

  let value: Value = current ? { t: "ref", id: current.id } : unknown("unresolved root");
  for (let i = start; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined) break;
    if (value.t !== "ref") return value.t === "unknown" ? value : unknown(`\`${seg}\` cannot be read off a ${value.t}`);
    const holder = instanceOf(ctx.world, value.id);
    if (!holder) return unknown(`\`${seg}\` has no instance to read from`);
    value = readMember(holder, seg);
  }
  return value;
}

/** Instances of `concept` scoped through their unique subject-typed relation (§3 auto-scoping). */
export function scopedInstances(concept: string, ctx: EvalContext): Instance[] {
  const all = ctx.world.instances.filter(i => i.concept === concept);
  const subject = instanceOf(ctx.world, ctx.subject);
  if (!subject || subject.concept === concept) return all;
  const backlink = [...(ctx.model.concepts.get(concept)?.fields ?? new Map())]
    .find(([, f]) => f.type.k === "concept" && f.type.name === subject.concept);
  if (!backlink) return all;
  return all.filter(i => {
    const link = i.members.get(backlink[0]);
    return link !== undefined && link.t === "ref" && link.id === subject.id;
  });
}

export function evaluate(expr: Expr, ctx: EvalContext): Value {
  switch (expr.kind) {
    case "error": return unknown("unparsed expression");
    case "paren": return evaluate(expr.inner, ctx);
    case "literal": {
      if (expr.type === "string") return { t: "string", s: expr.token.value };
      if (expr.type === "int") return { t: "int", n: Number(expr.token.text) };
      if (expr.type === "decimal") return { t: "decimal", n: Number(expr.token.text) };
      return durationOf(expr.token.text);
    }
    case "context": {
      if (expr.root.text === "today") return ctx.world.today;
      if (expr.root.text === "this") {
        const target = expr.segment ? null : ctx.outer ?? ctx.subject;
        return target === null ? unknown("`this` has no enclosing subject") : { t: "ref", id: target };
      }
      if (!ctx.world.actor) return unknown("this firing has no actor — the action is system-triggered");
      if (expr.segment?.text === "id") return { t: "id", v: ctx.world.actor.id };
      if (expr.segment?.text === "role") return { t: "word", w: ctx.world.actor.role };
      return unknown("the kernel provides `actor.id` and `actor.role` only");
    }
    case "path": return readPath(expr.segments.map(s => s.text), ctx);
    case "quantified": {
      const inner = scopedInstances(expr.concept.text, ctx);
      let sawUnknown = false;
      let sawTrue = false;
      for (const candidate of inner) {
        const held = expr.where === null
          ? ({ t: "bool", b: true } as Value)
          : evaluate(expr.where, { ...ctx, subject: candidate.id, outer: ctx.subject });
        if (held.t === "unknown") { sawUnknown = true; continue; }
        if (held.t === "bool" && held.b) { sawTrue = true; break; }
      }
      const wants = expr.quantifier.text === "some";
      if (sawTrue) return { t: "bool", b: wants };
      if (sawUnknown) return unknown(`a ${expr.concept.text} instance carries an unset member the restriction reads`);
      return { t: "bool", b: !wants };
    }
    case "unary": {
      const inner = evaluate(expr.operand, ctx);
      if (inner.t === "unknown") return inner;
      if (inner.t !== "bool") return unknown(`\`not\` needs a predicate, got ${inner.t}`);
      return { t: "bool", b: !inner.b };
    }
    case "binary": {
      const op = expr.op.text;
      if (op === "and" || op === "or") {
        const left = evaluate(expr.left, ctx);
        // Short-circuit through unknown: `false and ?` is false, `true or ?` is true.
        if (left.t === "bool" && left.b === (op === "or")) return left;
        const right = evaluate(expr.right, ctx);
        if (right.t === "bool" && right.b === (op === "or")) return right;
        if (left.t === "unknown") return left;
        if (right.t === "unknown") return right;
        if (left.t !== "bool" || right.t !== "bool") return unknown(`\`${op}\` needs predicates`);
        return { t: "bool", b: op === "and" ? left.b && right.b : left.b || right.b };
      }
      const left = evaluate(expr.left, ctx);
      const right = evaluate(expr.right, ctx);
      if (["=", "!=", "<", "<=", ">", ">=", "in"].includes(op)) return compare(op === "in" ? "=" : op, left, right);
      return arithmetic(op, left, right);
    }
  }
}

/** A predicate's verdict, with unknown kept distinct from false — partiality never reads as failure. */
export function holds(expr: Expr | null, ctx: EvalContext): boolean | null {
  if (expr === null) return true;
  const v = evaluate(expr, ctx);
  return v.t === "bool" ? v.b : null;
}
