---
name: meant-modeling
description: Discipline for editing meant model files (.meant, or ```meant fenced blocks in .md). Use whenever creating or modifying meant declarations — concepts, dimensions, shapes, actions, invariants, scenarios — or processing prose requirements into a model.
---

# Meant Lang modeling

You are editing a checked language. The validator is the editor; diagnostics are the interface. The model is decided by the human operator — you draft, the checker verdicts mechanically, the operator verdicts semantically.

Model files are `.meant` files, or ```meant fenced blocks inside `.md` files — extracted and checked identically. A domain may span files: every file in one run whose `domain` header names it is one model, so check the model's directory, not the file you edited — alone, a file cannot resolve what its siblings declare.

## The loop

1. Edit the model file.
2. Run `meant check <model dir> --json` (a PostToolUse hook may do this for you — treat its output identically).
3. Fix every diagnostic you can fix without inventing meaning: unresolved refs you misspelled, type errors, structure errors. Each diagnostic cites its law (V#/P/L-#) and a fix-shape — follow it. Unfamiliar law: `meant check --explain <LAW>`.
4. A diagnostic you can only fix by adding vocabulary or changing a decision is not yours to absorb silently — surface it (step below).
5. Repeat until green or until every remaining item is surfaced.
6. Once green, run `meant sim <model dir>` and `meant report <model dir>`. Green is well-formed, not true. Finish with `meant fmt <file>`.

## Starting from code

When the operator asks for a model of an existing application:

1. Model one workflow. If the operator has not named one ("sending an invoice"), ask which; then stay inside it. One workflow the operator reviews beats a whole-app model nobody reads.
2. Create `.meant/model.meant` with a `domain <name>` header and `mode code-first`: production is presumed right, so a red verdict accuses the model. Start `.meant/history.md` with one numbered entry per model change: what changed, why, and check/sim state after. Pass `.meant` to every command explicitly; directory sweeps skip dot-directories.
3. Mine only that workflow's code, citing file:line for every inference:
   - `by` actors ← role and permission checks
   - concepts and fields ← persisted entities
   - dimensions ← enums, status columns, closed string sets
   - actions ← handlers and endpoints that change state
   - `requires … else CODE` ← guard clauses and the errors they return
   - effects ← writes and created records
   - `verified-by` ← existing tests that exercise the action
4. Mined is not decided: present every concept, dimension, value, action and deny code under Vocabulary admission and wait for the verdict. Where the code contradicts itself or the operator, write `undecided @owner "…"` on that line, never a guess.
5. Run the loop to green, then `meant sim .meant` and `meant report .meant`; show the operator the falsified claims, unprobeable sentences, and open questions.
6. Run `meant skill install` and register the hook it prints. Add a short section to the repo's agent instructions (CLAUDE.md or AGENTS.md) naming `.meant/model.meant`, `.meant/history.md`, and this loop.

## Reading simulation

`meant sim` answers a different question from `meant check`: not "is this well-formed" but "are its claims true".

- **`falsified`** — a counterexample exists, shrunk to the minimal world. This is a bug in the model or in the claim; it is never noise. Read the counterexample, decide which of the two is wrong, surface the choice.
- **`dead`** — no world satisfies the predicate within scope. Dead vocabulary.
- **`unprobeable`** — an opaque effect sentence blocks the evaluation. This is the *partiality account*, not a failure: it is the list of prose that would become mechanical if it were declared. Fix by declaring, or leave and know the cost.
- **`derived`** — the effects land in that region on their own. If a `-> Shape` is authored at a site that also reports `derived`, delete the arrow: it is a computed fact written down.
- **`skipped`** — out of scope by declaration (lane and prose expectations are the suite's; replay never advances the clock, so a "three days pass" step is residue).

`meant report` is the same honesty in aggregate: the opacity queue per declaration, residue patterns *with recurrence counts* (that is the recurrence bar's arithmetic — read it before proposing any new form), discovery candidates, and the questions inbox by `@handle`. A candidate is report-only: adoption is the operator's verdict, never yours.

## Vocabulary admission — propose, never smuggle

New concepts, dimensions, values, actions, shapes, deny codes: propose to the operator with the test results, wait for the verdict. Tests to run and show:

- **Dimension vs field**: can every possible value be written as a named domain word, additions being product decisions? Yes → dimension; no → field.
- **Bool corollary**: a bool field whose two states carry domain meaning is a disguised two-value dimension (`payment_standing = clear | blocked`, not `payment_issue: bool`).
- **`*_id` smell**: an id-shaped string field is a relation in costume — propose the concept-typed field; identity-only concepts are legal.
- **Consumer test**: name the checker or declaration that will consume the new construct. No consumer → do not propose it.

## Effect discipline

- Deltas (`path op expr`) and creations (`new Concept with …`) first — they simulate and derive landings.
- `-> Shape` only where the outcome is opaque; if the landing derives from your deltas, author nothing.
- Everything else is a bare ref-anchored sentence: Capitalized/ID tokens must resolve, quoted strings are instance data, lowercase residue is honestly unverified.
- **One home per claim**: never restate in a sentence what deltas, creations, or a target shape's `where` already say.
- **Residue is a sensor**: an awkward sentence is usually a missing declaration wearing prose (a missing action, concept, or dimension value). Say which declaration would dissolve it, and propose it.

## Growing the grammar — the recurrence bar

Never propose new syntax from one example. A sentence pattern must recur (≥2 independent occurrences, ideally across domains) before it earns a form proposal. One-offs stay prose by rule, not by oversight.

## Unknowns

Park anything genuinely undecided as `undecided @owner "one line"` at the exact line of the gap — never as a TODO comment, never silently resolved by your own guess.

## Grammar reference

`meant spec` prints the table of contents of the normative grammar; `meant spec <section>` prints one section. Prefer it over guessing syntax.

## Standing laws (do not relitigate)

Quotes = instance data, always. Deny-by-default: an unlisted actor cannot act; `by anyone` does not exist — enumerate. Computed facts are never authored (has-many, landings over deltas, applicable shapes, drift scoping, provenance). No LLM sits in the checking path — you author, the deterministic toolkit verdicts. Pin intentional rule violations in test fixtures with an inline `# EXPECT: <law>` on the offending line.
