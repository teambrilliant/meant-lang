# Meant Lang

**Meant Lang** is a DSL for business intent and observable behavior: a small sub-Turing kernel language (8 statement kinds) that each application fills with its own vocabulary, plus a deterministic checker over it. Humans decide the behavior, agents work from the model, and engineers choose the implementation. The toolkit checks models; application conformance and runtime checking remain future work.

## The spec is the authority

- `spec/meant-grammar-v0.md` — the normative grammar. §15 (keyword inventory) and §17 (lexical layer) are normative too, not appendices.
- `spec/errata.md` — the E# change log, append-only. E1–E55 are folded into the spec body (their history is not published); new entries start at E56. The body is what you implement against.

Where spec and code disagree, the spec wins. Where the spec is ambiguous, that is a **finding**: implement the narrowest reading and surface the ambiguity as a proposed erratum — never silently pick a generous interpretation.

## The toolchain

Seven commands, one model-result schema (`CheckResult` in `src/diagnostics.ts` — `check` fills `diagnostics`, `sim` adds `verdicts`, `report` adds `opacity`/`patterns`/`candidates`/`questions`). TypeScript on Bun, no build step.

```bash
bun run meant check <paths> [--json]    # lexer → parser (CST, trivia preserved) → resolver → V/P/L laws
bun run meant check --explain <law>     # the law's normative text + the fixture that plants it
bun run meant fmt <paths> [--check]     # canonical form; --check exits 1 on drift
bun run meant sim <paths> [--json]      # witness · probe · replay · the computed machine
bun run meant report <paths> [--json]   # opacity queue · residue patterns · candidates · questions
bun test                               # goldens + round-trip + EXPECT / SIM-EXPECT harnesses
bun run typecheck
```

- `check` exits 1 iff error-severity diagnostics exist; `sim` exits 1 on an error or a falsified claim.
- `src/diagnostics.ts` is the agent interface. **Law + code strings are API**, and so are verdict `status` values (`verified` · `falsified` · `dead` · `unprobeable` · `skipped` · `derived`) — goldens, the SIM-EXPECT harness, and agents key on all of them; changing one is a recorded decision, not a rename.
- Law namespaces: `V1`–`V15` (spec §7 obligations; `V12` is sim-only — it needs witnesses) · `P` structural/lexical violations of the productions themselves (§1–§4, §17; the message cites the section) · `L-…` structural smells, always info-grade.
- **Zero runtime dependencies** — a constraint, not a preference. Any dependency, runtime or dev, needs explicit agreement first.
- **Simulation is total, never optimistic.** `unknown` is a value in the evaluator, not an exception: an opaque effect degrades one claim to `unprobeable` and is reported, never quietly assumed. Coverage never overstates.
- **A probe is a falsifier, not a sampler.** It searches for the world where a claim is FALSE, and escalates the scope once before calling anything verified — the original S001 tick claim verified against the first witness a human reaches by hand and was still wrong (`fixtures/sim-s001-tick.meant` keeps that bug alive).
- **Discovery forbids false positives.** False negatives are fine; a candidate a human adopts becomes a law. Every template asks whether an opaque sentence could do the thing it is about to say nothing does, and downgrades itself to `near` naming the blocker if so.
- CST trivia is non-negotiable: `fmt` is its only consumer and its property tests (idempotency + token/CST preservation) are what keep the parser honest.
- `fmt` refuses a file the parser convicts — half the corpus exists to plant structural violations, and silently repairing a tab deletes the fixture that proves tabs are illegal.

## Editor support

`editors/zed/` is a Zed dev extension (grammar-only — no Rust). Its grammar lives in a **separate repo**, [teambrilliant/tree-sitter-meant](https://github.com/teambrilliant/tree-sitter-meant), pinned by sha in `extension.toml`; that repo has its own `tree-sitter-cli` dev dep, so the zero-runtime-deps constraint is this repo's only.

- The grammar is deliberately **line-oriented**: a line opening with a kind keyword is a `declaration` (`kind`/`id`/`name` fields — outline), every other line is a token stream (color). No blocks, no indentation. Production churn never bills an edit there; only §15 keyword changes do, and `scripts/check-keywords.ts` compares `keywords.json` against live `meant spec 15`.
- A low-precedence single-char fallback token means stray prose punctuation can never produce an `ERROR` node. Do not add balanced-bracket or block rules — that property is what makes "the whole corpus parses clean" a hard gate.
- `editors/zed/languages/meant/highlights.scm` is canonical; `queries/highlights.scm` in the grammar repo is its copy, for `bun run highlight` (terminal preview, no Zed).
- Any grammar change = `bun run check` + commit in `tree-sitter-meant` → new sha in `extension.toml` → reinstall the dev extension. Iterate at the terminal, not in Zed.

## Website

`site/` is meantlang.dev — static HTML/CSS, no build step, deployed by GitHub Pages (`.github/workflows/pages.yml`) from the public repo only. Derived files — `site/skill.md`, `site/spec.md`, `site/llms-full.txt`, `site/examples/invoicing.result.json` — come from `scripts/site.ts`; `tests/site.test.ts` fails when one is stale. Regenerate with `bun scripts/site.ts`, then re-read the page copy that quotes the recorded results — the test pins the derived files, not the HTML.

## Corpora — two, never conflated

**Conformance** — `fixtures/*.meant`. Expectations live in the fixtures: `# EXPECT: <law>` on the offending line (`# EXPECT-NEXT:` when the line itself cannot carry a comment), comma-separated when one plant fires several laws. Simulation plants use the same discipline in `fixtures/sim-*.meant`: `# SIM-EXPECT: falsified <claim-id>` · `dead <Shape>` · `denied <CODE>`, on the line the verdict points at; a `sim-*` fixture with no plants must come back with nothing falsified and nothing dead. `known-good.meant` must yield **zero errors and zero warnings** at every commit — a new diagnostic on it is a checker bug by definition, unless the maintainer verdicts the fixture wrong, which is a fixture change with its own note. Every new erratum lands with a fixture.

**Discovery** — application models live with their applications, not here: each modeled app repo carries `.meant/model.meant` plus `.meant/history.md` (its numbered change log). Pass `.meant` or the model path explicitly; broad directory searches skip dot-directories. Diagnostics on an app model are *findings*, triaged in that log: model bug → fix plus a delta entry; checker bug → fix the checker. **Never weaken a rule to quiet a model.** In this repo, `fixtures/discovery-*.meant` are neutral reproductions of the derivation and mining structures under test.

## Design laws — apply to every grammar proposal, in order

1. Consumer test: a kind/clause must be consumed by a checker, or it dies (killed: module, policy, rule)
2. Computed-fact rule: never author what tooling derives (killed: impl, mirrors, driver, persisted IR)
3. One-form rule: one meaning, one syntax; sugar is negative value (killed: states, given/when/then)
4. Mandatory implies consumed (owner → resolvable @handle)

- Model anchors to behavior, never source; the only authored anchor is `verified-by`
- Kernel is sub-Turing (total predicates, tables, arithmetic); Turing-completeness lives in app code/tests
- Text + explicit IDs (S001/A004) are the source of truth; no persisted IR, no patch API
- Every token must resolve to a declaration in the domain (incl. deny codes); quotes = instance data
- Kernel: 8 kinds. Libraries (`uses`) are deterministic macros over kernel semantics only

## Process

- Language changes are reviewed clause by clause; each verdict = delete or armor. Record every language change as an erratum (E#) in `spec/errata.md`, landing with its fixture.
- New forms must clear the **recurrence bar**: ≥2 independent occurrences, ideally across domains. One-offs stay prose by rule, not by oversight.
- The block test for new syntax: does it read as a statement about the world (not a transliteration of implementation architecture)? "wtf does that mean" = failed.
- Agent editing discipline ships in the binary: `.claude/skills/meant-modeling/SKILL.md` is generated output of `meant skill install` (drift-locked by a test — edit `src/skill.md`, regenerate); the `meant hook` subcommand (PostToolUse) feeds `meant check --json` back into the session after any model edit.
- Name is **Meant Lang**; executable `meant`, model extension `.meant`, Markdown fence tag `meant`. Modes: model-first / code-first.
- Markdown in this repo: soft wraps only — never hard-wrap prose lines.
