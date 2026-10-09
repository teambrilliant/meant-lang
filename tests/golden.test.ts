import { test, expect } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { check } from "../src/index";

/**
 * The conformance corpus — fixtures/, .meant and .md hosts alike, and directories as multi-file runs: expectations are pinned in the
 * fixtures themselves (see expectations.test.ts); the snapshot pins severity, message, and
 * position on top of that. Discovery models live with their applications (in each app repo's
 * .meant/ directory), not here.
 */
// a directory is one case: one run, whose files merge by `domain` header (E54)
const CASES = readdirSync("fixtures").sort()
  .filter(f => /\.(meant|md)$/.test(f) || statSync(`fixtures/${f}`).isDirectory())
  .map(f => `fixtures/${f}`);

for (const file of CASES) {
  test(`check ${file}`, () => {
    const result = check([file]);
    expect(result.diagnostics).toMatchSnapshot();
  });
}
