import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { lex } from "../src/lexer";
import { parse } from "../src/parser";
import { format, formatDocument } from "../src/printer";

const FILES = readdirSync("fixtures").filter(f => /\.(meant|md)$/.test(f)).sort().map(f => `fixtures/${f}`);

/** Token texts, in order — the whitespace-insensitive content of a model file. */
const tokenTexts = (source: string, file: string): string[] =>
  lex(source, file).tokens.filter(t => t.kind !== "EOL").map(t => t.text);

/** The CST with every position, offset, and trivia field dropped: equivalence modulo whitespace. */
function cstShape(source: string, file: string): string {
  const dropped = new Set(["leading", "start", "end", "pos", "endPos", "range", "line", "col"]);
  return JSON.stringify(parse(lex(source, file)).model, (key, value) => dropped.has(key) ? undefined : value);
}

for (const file of FILES) {
  test(`fmt is idempotent and semantic-preserving on ${file}`, () => {
    const source = readFileSync(file, "utf8");
    const once = format(source, file);
    expect(format(once, file)).toBe(once);
    expect(tokenTexts(once, file)).toEqual(tokenTexts(source, file));
    expect(cstShape(once, file)).toBe(cstShape(source, file));
  });
}

test("fmt canonicalizes indentation, operator spacing, and comment gutters", () => {
  const source = [
    "domain lending",
    "    mode model-first",
    "",
    "",
    "",
    "concept Loan",
    "      dimension status    =    open|returned      # the axis",
    "      field due_date: date",
    "",
    "",
    "      field member: Member",
    "",
  ].join("\n") + "\n";
  expect(format(source, "t.meant")).toBe([
    "domain lending",
    "  mode model-first",
    "",
    "",
    "concept Loan",
    "  dimension status = open | returned  # the axis",
    "  field due_date: date",
    "",
    "  field member: Member",
  ].join("\n") + "\n");
});

test("fmt never invents whitespace inside a glued run — the verified-by fragment survives", () => {
  const source = "action ReturnBook of Loan\n  verified-by      tests/lending/return.test.ts#returns\n";
  expect(format(source, "t.meant")).toBe("action ReturnBook of Loan\n  verified-by tests/lending/return.test.ts#returns\n");
});

test("fmt leaves a multi-line string's body untouched and re-indents only its opening line", () => {
  const source = 'concept Loan\n        "one borrowing\n   spanning lines"\n';
  expect(format(source, "t.meant")).toBe('concept Loan\n  "one borrowing\n   spanning lines"\n');
});

test("fmt formats inside meant-tagged fences only and preserves the surrounding prose (E53)", () => {
  const source = ["# Notes", "", "", "", "prose   stays   as   written", "", "```meant", "domain x", "      mode  mixed", "```", "", "trailing prose"].join("\n") + "\n";
  const out = format(source, "t.md");
  expect(out).toBe(["# Notes", "", "", "", "prose   stays   as   written", "", "```meant", "domain x", "  mode mixed", "```", "", "trailing prose"].join("\n") + "\n");
});

test("fmt leaves untagged and otherwise-tagged fences verbatim — they are prose (E53)", () => {
  const source = ["# Notes", "", "```", "domain x", "      mode  mixed", "```", "", "```bash", "echo   spacing   preserved", "```"].join("\n") + "\n";
  expect(format(source, "t.md")).toBe(source);
});

test("fmt refuses a file the parser convicts — a planted tab is a fixture, not a typo to repair", () => {
  const source = readFileSync("fixtures/parse-tab-indent.meant", "utf8");
  const { text, skipped } = formatDocument(source, "fixtures/parse-tab-indent.meant");
  expect(skipped).toContain("P/tab-indent");
  expect(text).toBe(source);
});

test("fmt repairs a mis-indented clause instead of cementing it one level deeper", () => {
  const source = "concept A\n  field x: int\n      field y: int\n";
  const { text, skipped } = formatDocument(source, "t.meant");
  expect(skipped).toBeNull();
  expect(text).toBe("concept A\n  field x: int\n  field y: int\n");
  // and the repair is real: the formatted file no longer carries the conviction
  expect(parse(lex(text, "t.meant")).diagnostics).toEqual([]);
});

test("fmt repairs a mis-indented effect line the same way", () => {
  const source = "concept A\n  field n: int\n\naction Act of A\n  effect\n    n += 1\n        n += 2\n";
  const { text } = formatDocument(source, "t.meant");
  expect(text.split("\n").slice(4, 7)).toEqual(["  effect", "    n += 1", "    n += 2"]);
  expect(parse(lex(text, "t.meant")).diagnostics).toEqual([]);
});

test("fmt formats a file with semantic errors: only structural convictions stay its hand", () => {
  const source = readFileSync("fixtures/known-bad.meant", "utf8");
  expect(formatDocument(source, "fixtures/known-bad.meant").skipped).toBeNull();
});

test("every corpus file the formatter accepts is already in canonical form", () => {
  for (const file of FILES) {
    const source = readFileSync(file, "utf8");
    const { text, skipped } = formatDocument(source, file);
    if (skipped !== null) continue;
    expect({ file, canonical: text === source }).toEqual({ file, canonical: true });
  }
});
