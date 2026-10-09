import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { check } from "./index";
import { simulate } from "./sim";

/**
 * `meant check --explain <law>` — the law's normative text plus a fixture that exercises it.
 *
 * The text is quoted from §7 / §17, not paraphrased: an agent reading the explanation and an agent
 * reading the spec must be reading the same sentence. The example is found by running the
 * conformance corpus and taking the first real occurrence, so an explanation can never cite a
 * fixture line that has stopped firing.
 */

interface LawText { text: string; source: string }

const LAWS: Record<string, LawText> = {
  V1: { source: "§7", text: "IDs unique per domain." },
  V2: { source: "§7", text: "Every reference resolves (shapes, actions, invariants, lanes, dimension values, deny codes, concepts)." },
  V3: { source: "§7", text: "Dimension values closed; unknown value = error." },
  V4: { source: "§7", text: "Predicates/effects type-check over declared fields; paths resolve." },
  V5: { source: "§7", text: "Fuse: wait-list entries are declared actions; the timeout target is a declared system action." },
  V6: { source: "§7", text: "`else` targets are DenyCode values; every value carries copy." },
  V7: { source: "§7", text: "`check by judged` requires `rubric`; a governed output requires a resolvable `fallback`." },
  V8: { source: "§7", text: "Sentence lint: unresolved Capitalized/ID tokens flagged; quoted strings exempt." },
  V9: { source: "§7", text: "An action's subject is determinable (`of`, or the unique subject of its shape refs); all shape refs share it." },
  V10: { source: "§7", text: "`(planned)` statements carry no `verified-by`." },
  V11: { source: "§7", text: "Exposure facts resolve (subject path, related-concept path/ref); relationless concept-facts flagged as detector-required." },
  V12: { source: "§7", text: "Machine sanity over the *computed* machine: unreachable shape = warning; dead region (unsatisfiable `where`) = warning." },
  V13: { source: "§7", text: "Every `undecided` carries a resolvable `@handle`." },
  V14: { source: "§7", text: "`actor.`-conditions only inside actor blocks; block actors ⊆ the admission list." },
  V15: { source: "§7", text: "A kernel hook used without its well-known declaration = error (`by`/`to`/`actor.role` → `dimension actor`; `else`/`denied` → `concept DenyCode` with `copy: string`)." },
  P: {
    source: "§1–§4, §17",
    text: "A structural or lexical violation of the productions themselves. The message cites the section: "
      + "indentation is 2 spaces per level and tabs are illegal; a sentence occupies one logical line; "
      + "operand lists are comma-separated on one line; branch bodies are block-only; `values` entries are line entries; "
      + "a domain spans every file in the run whose header names it, and its clauses carry one value across all of them (§1).",
  },
  "L-bool": { source: "§4.2", text: "A bool field whose two states carry domain meaning is a disguised two-value dimension (`payment_standing = clear | blocked`, not `payment_issue: bool`)." },
  "L-id-string": { source: "§4.1 / E35", text: "An `*_id`-suffixed string field is a relation in costume; declare the concept-typed relation and compare identities with `.id`." },
  "L-no-writer": { source: "§7 (structural smells)", text: "A field no action writes: either the action that moves it is missing, or the field is." },
  "L-keyword-shadow": { source: "§15", text: "A §15 kernel keyword used as application vocabulary. The inventory is the one-form rule's enforcement surface; shadowing it invites permanent parse ambiguity." },
  "L-unref-shape": { source: "§7 (structural smells)", text: "A shape declared but never referenced — the state vocabulary is consumed on both sides of the function or not at all." },
  "L-unref-action": { source: "§7 (structural smells)", text: "An action declared but never referenced by a scenario, fuse, or sentence." },
  "L-unref-lane": { source: "§4.3", text: "A declared lane carrying no exposure claim or expectation — a dark lane." },
  "L-dim-single-consumer": { source: "§4.2", text: "A domain-level dimension with ≤1 consumer is dead-or-nestable vocabulary." },
  "L-near-miss-delta": { source: "§17", text: "Delta recognition is whole-line: a line is a delta iff it parses wholly as `path op expr`. A sentence opening with `path op` is probably an intended delta." },
};

export const LAW_CODES: string[] = Object.keys(LAWS);

/**
 * The place in the conformance corpus where this law actually fires. A fixture that *plants* the
 * law wins over one that merely trips it, so the example a reader gets is the one written to teach
 * the law rather than a bystander.
 */
// the conformance corpus ships with the package; resolve it from here, never from the caller's cwd
const PACKAGE_ROOT = join(import.meta.dir, "..");
const FIXTURES = join(PACKAGE_ROOT, "fixtures");

function example(law: string): string[] {
  const candidates = [
    ...check([FIXTURES]).diagnostics.filter(d => d.law === law),
    ...simulate([FIXTURES]).diagnostics.filter(d => d.law === law),
  ];
  const sourceLine = (d: { file: string; range: { start: { line: number } } }): string =>
    readFileSync(d.file, "utf8").split("\n")[d.range.start.line - 1] ?? "";
  const onAPlant = candidates.filter(d => /(SIM-)?EXPECT:/.test(sourceLine(d)));
  const named = onAPlant.find(d => { const line = sourceLine(d); return line.includes(law) || line.includes(d.code) });
  const found = named ?? onAPlant[0] ?? candidates[0];
  if (!found) return ["  (no fixture in `fixtures/` currently exercises this law)"];
  const lines = readFileSync(found.file, "utf8").split("\n");
  const at = found.range.start.line;
  const out = [`  ${relative(PACKAGE_ROOT, found.file)}:${at}`];
  for (let n = Math.max(1, at - 1); n <= Math.min(lines.length, at + 1); n++) {
    out.push(`  ${n === at ? ">" : " "} ${String(n).padStart(3)} │ ${lines[n - 1] ?? ""}`);
  }
  out.push("", `  ${found.severity}: ${found.message}`);
  if (found.fix) out.push(`  → ${found.fix}`);
  return out;
}

export function explain(law: string): string | null {
  const entry = LAWS[law];
  if (!entry) return null;
  return [`${law}  (${entry.source})`, "", `  ${entry.text}`, "", "example:", ...example(law)].join("\n");
}
