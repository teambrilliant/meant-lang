import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { lex, unlex } from "../src/lexer";

const FILES = readdirSync("fixtures").filter(f => /\.(meant|md)$/.test(f)).sort().map(f => `fixtures/${f}`);

for (const file of FILES) {
  test(`lexer round-trips ${file} byte-exactly`, () => {
    const source = readFileSync(file, "utf8");
    const result = lex(source, file);
    expect(unlex(result)).toBe(source);
  });
}
