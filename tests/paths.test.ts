import { test, expect } from "bun:test";
import { check, expandAll } from "../src/index";
import { simulate } from "../src/sim";
import { report } from "../src/report";

/**
 * A mistyped path is a finding, not a crash.
 *
 * `check` guarded its own expansion and the other three commands did not, so `meant fmt typo.meant`
 * printed a Node stack trace while `meant check typo.meant` printed a diagnostic. One shared
 * expansion means the answer no longer depends on which verb you typed.
 */
test("an unreadable path is reported, not thrown", () => {
  const { files, unreadable } = expandAll(["definitely-not-here.meant"]);
  expect(files).toEqual([]);
  expect(unreadable.map(d => `${d.law}/${d.code}`)).toEqual(["P/unreadable-path"]);
  expect(unreadable[0]?.fix).toBeTruthy();
});

test("every command reports the same law for the same bad path", () => {
  const bad = ["definitely-not-here.meant"];
  for (const [name, result] of [["check", check(bad)], ["sim", simulate(bad)], ["report", report(bad)]] as const) {
    expect({ name, laws: result.diagnostics.map(d => `${d.law}/${d.code}`) })
      .toEqual({ name, laws: ["P/unreadable-path"] });
    expect({ name, errors: result.summary.errors }).toEqual({ name, errors: 1 });
  }
});

test("readable paths alongside an unreadable one still get checked", () => {
  const paths = ["fixtures/known-good.meant", "fixtures/known-bad.meant", "definitely-not-here.meant"];
  for (const result of [check(paths), simulate(paths), report(paths)]) {
    expect(result.files).toEqual(paths.slice(0, 2));
    expect(result.diagnostics.filter(d => d.code === "unreadable-path").length).toBe(1);
    expect(result.diagnostics.some(d => d.file === "fixtures/known-bad.meant" && d.law === "V2" && d.code === "unresolved-ref")).toBe(true);
  }
});

test("a directory expands to its model-capable files and nothing else", () => {
  const { files, unreadable } = expandAll(["spec"]);
  expect(unreadable).toEqual([]);
  // .md hosts are listed by extension; whether they carry meant-tagged fences is the lexer's call (E53).
  expect(files).toEqual(["spec/errata.md", "spec/meant-grammar-v0.md"]);
});
