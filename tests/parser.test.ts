import { test, expect } from "bun:test";
import { lex } from "../src/lexer";
import { parse } from "../src/parser";
import { resolve } from "../src/resolve";
import { check } from "../src/index";

/**
 * §17's continuation join and where it must stop.
 *
 * The bug these guard against was silent, which is what made it bad: a clause line one level too
 * deep was absorbed into the line above, that line's production read its fixed prefix, and the rest
 * was dropped with no diagnostic. `meant check` reported a clean file that was missing a field.
 *
 * So each case asserts twice — that the mis-indentation is convicted, AND that the declaration
 * survives. An error alone would be an improvement that still loses the author's work.
 */
const model = (source: string) => {
  const parsed = parse(lex(source, "t.meant"));
  return { model: resolve(parsed.model), diagnostics: parsed.diagnostics };
};

const indentErrors = (diagnostics: ReturnType<typeof model>["diagnostics"]) =>
  diagnostics.filter(d => d.code === "indent-mismatch").map(d => d.range.start.line);

test("an over-indented field is convicted and still declared", () => {
  const { model: m, diagnostics } = model("concept A\n  field x: int\n      field y: int\n");
  expect(indentErrors(diagnostics)).toEqual([3]);
  expect([...(m.concepts.get("A")?.fields.keys() ?? [])]).toEqual(["x", "y"]);
});

test("an over-indented nested dimension is convicted and still declared", () => {
  const { model: m, diagnostics } = model("concept A\n  dimension s = open | shut\n      dimension t = hot | cold\n");
  expect(indentErrors(diagnostics)).toEqual([3]);
  expect([...(m.concepts.get("A")?.dimensions.keys() ?? [])]).toEqual(["s", "t"]);
});

test("an over-indented requires is convicted and still gates", () => {
  const { model: m, diagnostics } = model(
    "concept A\n  field n: int\n\naction Act of A\n  requires n > 1\n      requires n < 9\n  effect n += 1\n");
  expect(indentErrors(diagnostics)).toEqual([6]);
  expect(m.actions.get("Act")?.conditions.length).toBe(2);
});

test("an over-indented delta is convicted and still runs", () => {
  const { model: m, diagnostics } = model(
    "concept A\n  field n: int\n\naction Act of A\n  effect\n    n += 1\n        n += 2\n");
  expect(indentErrors(diagnostics)).toEqual([7]);
  expect(m.actions.get("Act")?.effect?.lines.length).toBe(2);
});

test("an over-indented creation is convicted and still creates", () => {
  const { model: m, diagnostics } = model(
    "concept A\n  field n: int\n\naction Act of A\n  effect\n    n += 1\n        new A\n");
  expect(indentErrors(diagnostics)).toEqual([7]);
  const lines = m.actions.get("Act")?.effect?.lines ?? [];
  expect(lines.map(l => l.kind)).toEqual(["delta", "creation"]);
});

// ---------------------------------------------------------------- the join must still join

test("a predicate wraps across lines: `and` continues, it does not open a clause", () => {
  const { model: m, diagnostics } = model(
    "concept A\n  dimension s = open | shut\n  field n: int\n\nshape S of A\n  where s = open\n    and n > 1\n");
  expect(diagnostics).toEqual([]);
  expect(m.shapes.get("S")?.where?.kind).toBe("binary");
});

test("a dimension's value list wraps across lines", () => {
  const { model: m, diagnostics } = model("concept A\n  dimension t = a | b\n    | c | d\n");
  expect(diagnostics).toEqual([]);
  expect(m.concepts.get("A")?.dimensions.get("t")?.values.map(v => v.text)).toEqual(["a", "b", "c", "d"]);
});

test("a creation's `with` wraps across lines — `with` continues, it never opens", () => {
  const { model: m, diagnostics } = model(
    "concept L\n  dimension s = open | shut\n\naction Act of L\n  effect\n    new L\n      with s = open\n");
  expect(diagnostics).toEqual([]);
  const line = m.actions.get("Act")?.effect?.lines[0];
  expect(line?.kind).toBe("creation");
  expect(line?.kind === "creation" ? line.assignments.length : 0).toBe(1);
});

test("a block-opening clause keeps its block: `effect` does not eat its own lines as siblings", () => {
  const { model: m, diagnostics } = model(
    "concept A\n  field n: int\n\naction Act of A\n  effect\n    new A\n    n += 1\n");
  expect(diagnostics).toEqual([]);
  expect(m.actions.get("Act")?.effect?.lines.length).toBe(2);
});

test("the construct rule convicts nothing that was clean: the gate and the discovery fixtures stay green", () => {
  const result = check(["fixtures/known-good.meant", "fixtures/discovery-held-change.meant", "fixtures/discovery-noise-cap.meant"]);
  expect({ errors: result.summary.errors, warnings: result.summary.warnings }).toEqual({ errors: 0, warnings: 0 });
});
