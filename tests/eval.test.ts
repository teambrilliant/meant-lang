import { test, expect } from "bun:test";
import { lex } from "../src/lexer";
import { parse } from "../src/parser";
import { resolve } from "../src/resolve";
import type { ResolvedModel } from "../src/resolve";
import type { Value, World } from "../src/eval";
import { addMonths, date, evaluate, parseDate, show } from "../src/eval";
import { addInstance, context, emptyWorld, fire } from "../src/store";

const MODEL = `
domain t
  mode model-first

dimension actor = customer

concept Customer
  "identity only"

concept Sub
  dimension status = active | cancelled
  field customer: Customer
  field n: int
  field count: int
  field due: date
  field every: duration

concept Shadow
  dimension state = pending | applied
  field sub: Sub

shape Probe of Sub
  where PREDICATE

action Tick of Sub
  effect
    n = n + 1
    due = due + 1 month

action Reanchor of Sub
  effect
    due = today + 1 month

action Cancel of Sub
  by customer
  by customer:
    requires actor.id = customer.id
  effect
    status = cancelled
`;

function modelWith(predicate: string): ResolvedModel {
  const source = MODEL.replace("PREDICATE", predicate);
  return resolve(parse(lex(source, "t.meant")).model);
}

/** A world with one Sub (`Sub#1`), one Customer, and whatever Shadows the caller asks for. */
function world(members: Record<string, Value>, shadows: Array<Record<string, Value>> = []): World {
  const w = emptyWorld();
  const customer = addInstance(w, "Customer");
  const sub = addInstance(w, "Sub");
  sub.members.set("customer", { t: "ref", id: customer.id });
  for (const [k, v] of Object.entries(members)) sub.members.set(k, v);
  for (const s of shadows) {
    const shadow = addInstance(w, "Shadow");
    shadow.members.set("sub", { t: "ref", id: sub.id });
    for (const [k, v] of Object.entries(s)) shadow.members.set(k, v);
  }
  return w;
}

function check(predicate: string, members: Record<string, Value>, shadows: Array<Record<string, Value>> = []): Value {
  const model = modelWith(predicate);
  const shape = model.shapes.get("Probe");
  if (!shape?.where) throw new Error(`predicate did not parse: ${predicate}`);
  const w = world(members, shadows);
  return evaluate(shape.where, context(model, w, "Sub#1"));
}

const int = (n: number): Value => ({ t: "int", n });
const word = (w: string): Value => ({ t: "word", w });

// ---------------------------------------------------------------- calendar (E22)

test("date + N months clamps to month end", () => {
  expect(show(addMonths(date(2026, 1, 31) as never, 1))).toBe("2026-02-28");
  expect(show(addMonths(date(2028, 1, 31) as never, 1))).toBe("2028-02-29");
  expect(show(addMonths(date(2026, 3, 31) as never, 1))).toBe("2026-04-30");
  expect(show(addMonths(date(2026, 1, 15) as never, 1))).toBe("2026-02-15");
  expect(show(addMonths(date(2026, 12, 31) as never, 2))).toBe("2027-02-28");
  expect(show(addMonths(date(2026, 3, 31) as never, -1))).toBe("2026-02-28");
});

test("clamping is not sticky: the day survives in the source date", () => {
  const jan31 = date(2026, 1, 31) as never;
  expect(show(addMonths(jan31, 2))).toBe("2026-03-31");
});

test("duration arithmetic composes weeks, days, and months", () => {
  expect(show(check("due + 2 weeks = due", { due: parseDate("2026-03-01") }))).toBe("false");
  expect(show(check("due + 2 weeks", { due: parseDate("2026-03-01") }))).toBe("2026-03-15");
  expect(show(check("due - 1 day", { due: parseDate("2026-03-01") }))).toBe("2026-02-28");
  expect(show(check("due - due", { due: parseDate("2026-03-01") }))).toBe("0 days");
  expect(show(check("every + 3 days", { every: { t: "duration", months: 1, days: 0 } }))).toBe("1 months + 3 days");
});

test("sub-day units floor to zero days — v0 refuses time-of-day (§13)", () => {
  expect(show(check("due + 5 h", { due: parseDate("2026-03-01") }))).toBe("2026-03-01");
});

// ---------------------------------------------------------------- context entities

test("today binds from the world and every read in one evaluation sees the same value", () => {
  expect(show(check("today = today", {}))).toBe("true");
  expect(show(check("today - today = 0 days", {}))).toBe("true");
  expect(show(check("due < today", { due: parseDate("2020-01-01") }))).toBe("true");
});

test("actor.id compares against a concept identity; a system firing makes it unknown", () => {
  const model = modelWith("status = active");
  const w = world({ status: word("active") });
  w.actor = { id: "Customer#1", role: "customer" };
  const fired = fire(model.actions.get("Cancel") as never, model, w, "Sub#1", "customer");
  expect(fired.denied).toBeNull();
  expect(show(fired.world.instances[1]?.members.get("status") as Value)).toBe("cancelled");

  const stranger = world({ status: word("active") });
  stranger.actor = { id: "Customer#9", role: "customer" };
  const refused = fire(model.actions.get("Cancel") as never, model, stranger, "Sub#1", "customer");
  expect(refused.denied?.code).toBe("FORBIDDEN");
});

// ---------------------------------------------------------------- quantifiers

test("quantifiers auto-scope through the unique subject-typed relation over multi-instance stores", () => {
  expect(show(check("no Shadow where state = pending", {}, []))).toBe("true");
  expect(show(check("no Shadow where state = pending", {}, [{ state: word("applied") }]))).toBe("true");
  expect(show(check("no Shadow where state = pending", {}, [{ state: word("applied") }, { state: word("pending") }]))).toBe("false");
  expect(show(check("some Shadow where state = pending", {}, [{ state: word("pending") }]))).toBe("true");
  expect(show(check("some Shadow where state != pending", {}, [{ state: word("pending") }]))).toBe("false");
});

test("a quantifier ignores instances belonging to another subject", () => {
  const model = modelWith("no Shadow where state = pending");
  const w = world({});
  const other = addInstance(w, "Sub");
  const foreign = addInstance(w, "Shadow");
  foreign.members.set("sub", { t: "ref", id: other.id });
  foreign.members.set("state", word("pending"));
  const shape = model.shapes.get("Probe");
  expect(show(evaluate(shape?.where as never, context(model, w, "Sub#1")))).toBe("true");
  expect(show(evaluate(shape?.where as never, context(model, w, other.id)))).toBe("false");
});

test("`this` inside a quantifier restriction binds the enclosing subject", () => {
  expect(show(check("some Shadow where sub = this", {}, [{ state: word("pending") }]))).toBe("true");
});

// ---------------------------------------------------------------- partiality

test("an unset member evaluates to unknown, and unknown never reads as false", () => {
  const v = check("n > 2", {});
  expect(v.t).toBe("unknown");
  expect(show(check("n > 2 or 1 = 1", {}))).toBe("true");
  expect(show(check("n > 2 and 1 = 2", {}))).toBe("false");
});

test("division by zero is unknown, not a throw — the interpreter is total", () => {
  expect(check("n / count = 1", { n: int(1), count: int(0) }).t).toBe("unknown");
});

// ---------------------------------------------------------------- effects

test("effect lines run in order, each seeing the writes before it", () => {
  const model = modelWith("status = active");
  const w = world({ n: int(2), due: parseDate("2026-01-31") });
  const fired = fire(model.actions.get("Tick") as never, model, w, "Sub#1", null);
  const sub = fired.world.instances.find(i => i.id === "Sub#1");
  expect(show(sub?.members.get("n") as Value)).toBe("3");
  expect(show(sub?.members.get("due") as Value)).toBe("2026-02-28");                  // E22 clamp through a delta
  expect(w.instances.find(i => i.id === "Sub#1")?.members.get("n")).toEqual(int(2));   // the pre-state survives

  const reanchored = fire(model.actions.get("Reanchor") as never, model, w, "Sub#1", null);
  expect(show(reanchored.world.instances.find(i => i.id === "Sub#1")?.members.get("due") as Value)).toBe("2026-04-15");
});

test("creation auto-binds the created instance's unique subject-typed relation (E49)", () => {
  const source = MODEL.replace("PREDICATE", "status = active")
    .replace("action Cancel of Sub", "action Stage of Sub\n  effect\n    new Shadow with state = pending\n\naction Cancel of Sub");
  const model = resolve(parse(lex(source, "t.meant")).model);
  const fired = fire(model.actions.get("Stage") as never, model, world({}), "Sub#1", null);
  const shadow = fired.world.instances.find(i => i.concept === "Shadow");
  expect(shadow?.members.get("sub")).toEqual({ t: "ref", id: "Sub#1" });
  expect(shadow?.members.get("state")).toEqual(word("pending"));
});
