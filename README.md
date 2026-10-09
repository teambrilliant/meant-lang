# Meant Lang

A DSL for business intent and observable behavior. People describe what an application should do in business vocabulary; engineers choose how to implement it. Coding agents work from that model and the engineer's technical design. The deterministic toolkit checks the model; application tests establish whether the implementation follows it.

## Why

Coding agents need a source of truth about what a system *means* — who may do what, under which conditions, with what observable outcomes — that can be checked. A Meant model captures that in eight statement kinds (concept, dimension, touchpoints, shape, exposure, action, invariant, scenario), with total-by-construction expressions and no Turing-completeness in the kernel. No LLM sits anywhere in the checking path: you author, the deterministic toolkit verdicts. The model anchors to behavior, never to source code.

## Example

From the conformance corpus (a tiny lending desk):

```
shape OverdueLoan of Loan
  where status = open and due_date < today
  wait [ReturnBook] timeout 3 days -> SendReminder

action ReturnBook
  "The member or the desk closes a loan."
  by member, librarian
  requires OpenLoan else NOT_OPEN
  by member:
    requires actor.id = member.id
  in OverdueLoan :
    effect
      a late return is noted at the desk
  effect
    status = returned
    the member's open loan count decreases by one
  verified-by tests/lending/return.test.ts#returns
```

Shapes are pure predicates over the world — overlapping views, never a state machine you maintain by hand; the `wait … timeout` fuse is the one construct that reacts to time. Actions declare who may act (`by`; an unlisted actor is denied by default), preconditions with deny codes, and observable outcomes as deltas and creations that the simulator can execute. Every capitalized token must resolve to a declaration in the file; quoted strings are instance data; lowercase residue sentences are honestly unverified.

## Installation

Requires [Bun](https://bun.sh) ≥ 1.4. Zero runtime dependencies.

```bash
bun add -g meant-lang
meant              # the onboarding page
```

## Start from your codebase

Give your coding agent one prompt that names one workflow:

```
Run `meant` and follow its instructions to build a Meant model of the <workflow> workflow in this app.
```

The agent reads the "Starting from code" section of `meant skill`, mines that workflow's code into `.meant/model.meant` (code-first mode), proposes vocabulary with file:line evidence for your verdict, and runs check, sim and report. You review the model, its falsified claims, and its open questions.

## Zed

The development extension in [`editors/zed/`](editors/zed/) provides `.meant` recognition, syntax highlighting, declaration outlines, `#` comments, and two-space indentation settings. It is grammar-only; model diagnostics come from the CLI and agent hook.

1. In Zed, run `zed: install dev extension` and select this repository’s `editors/zed` directory. Zed fetches the pinned grammar from [teambrilliant/tree-sitter-meant](https://github.com/teambrilliant/tree-sitter-meant) and compiles it during installation using its WASI SDK. See [Zed’s development-extension instructions](https://zed.dev/docs/extensions/developing-extensions).
2. Open [`fixtures/known-good.meant`](fixtures/known-good.meant). Confirm the selected language is **Meant Lang**, declaration names appear in the outline, comments and keywords are highlighted, and indentation uses two spaces. If installation fails, inspect `zed: open log`.

Grammar changes must pass that repository’s `bun run check`, be committed in that repository, and have their full commit SHA pinned in the extension before reinstalling. Generated material under `editors/zed/grammars/` is ignored.

## Usage

```bash
meant                             # orientation: what this is, the loop, the verb table
meant check <paths> [--json]      # lexer → parser → resolver → laws; exit 1 iff errors
meant check --explain <LAW>       # a law's normative text + worked example
meant fmt <paths> [--check]       # canonical formatting; --check exits 1 on drift
meant sim <paths>                 # witnesses, probes, scenario replay
meant report <paths>              # opacity queue, residue patterns, discovery candidates, questions
meant skill [install]             # the agent editing discipline (stdout, or written to .claude/skills/)
meant spec [<section> | --all]    # the normative grammar, sliceable by section
meant hook                       # PostToolUse feedback from a tool event on stdin
```

Paths are `.meant` files, or directories and `.md` files — models embedded in exact `meant` fences in Markdown are extracted and checked identically. Application models conventionally live in their own repository at `.meant/model.meant`, with decisions in `.meant/history.md`. Pass `.meant/model.meant` or `.meant` explicitly: searching `.` skips dot-directories.

A model may span files: every file in one run whose `domain <name>` header matches is one domain, resolved and simulated together — so point commands at the model's directory. Clauses may sit in any of its files; a key given two different values is a `P/domain-clause-conflict`.

Every diagnostic cites its law: `V1`–`V15` are the validator obligations from spec §7, `P` marks violations of the grammar productions themselves, and `L-…` are structural smells, always info-grade. `--json` is the agent interface; law and code strings are stable API.

## Agents

The binary teaches its own use: bare `meant` prints the bootstrap, `meant skill` prints the editing discipline for injection into any agent's context, and `meant skill install` persists it as a Claude Code skill in the host repo. A PostToolUse hook (`meant hook`) re-checks any edited model file (with the rest of its domain) and feeds diagnostics straight back into the session — the printed settings snippet wires it up. The model is decided by the human operator: agents draft, the checker verdicts mechanically, the operator verdicts semantically.

## Repository layout

```
spec/meant-grammar-v0.md   # the normative grammar — where spec and code disagree, the spec wins
spec/errata.md            # append-only change log (E#); E1–E55 folded into the grammar, new entries from E56
src/                      # the checker toolchain: TypeScript on Bun, zero runtime deps
fixtures/                 # conformance corpus; expectations inline via `# EXPECT: <law>`;
                          #   known-good.meant must stay at zero errors and zero warnings
examples/                 # complete neutral examples, including invoicing.meant
```

## Development

From a checkout, `bun install` (dev tooling only), then invoke the CLI as `bun run meant …`; `bun link` puts the checkout's `meant` on your PATH.

```bash
bun test              # goldens, lexer round-trip, fixture EXPECT harness
bun run typecheck
```

Zero runtime dependencies is a constraint, not a preference — any dependency, runtime or dev, needs explicit agreement first.

## Status

v0 developer preview: commands and diagnostics may change between releases. The grammar has been through more than 50 recorded errata driven by modeling real systems. The current toolkit validates and explores models. Automatic application conformance and continuous runtime checking remain future work.

## License

[MIT](LICENSE). Copyright (c) 2026 Brilliant Consulting SL. The license covers this repository's first-party tooling, editor support, specification, documentation, and examples. Contributions are welcome; commercial use and private modifications are permitted under the license.
