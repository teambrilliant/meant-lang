# Meant Lang Grammar — v0 (consolidated)

Status: consolidated 2026-10-03 — errata E1–E55 folded into the body; the change log lives in `spec/errata.md` (append-only). Scope: the authored text language plus the normative obligations it places on tooling; the TS mapping contract is summarized in §10.

Design laws, applied in order to every proposal: (1) **consumer test** — a kind or clause must be consumed by a checker, or it dies; (2) **computed-fact rule** — never author what tooling derives from the mapping or the runtime; (3) **one-form rule** — one meaning, one syntax; sugar is negative value in an agent-authored language; (4) mandatory implies consumed. Standing commitments: the model anchors to behavior, never to source (the one authored anchor is `verified-by`); the kernel is sub-Turing; text with stable IDs in git is the source of truth — no persisted IR, no patch API; quoted strings are instance data, always; every token resolves to a declaration in the domain.

## 1. Files and structure

- Extension `.meant`, UTF-8. A **domain** is every model file in a run whose `domain` header names it — the run is the paths a command is handed, nothing outside them joins; files split freely, may live anywhere the run reaches, and declaration order is irrelevant. A domain's clauses may sit in any of its files, but one key carries one value across all of them (a second, different value is a structural error); `uses` libraries union. A file with statements and no header is a domain of its own. Tooling also reads fenced code blocks tagged `meant` inside `.md` files (the sketch form), mapping positions to the host file; untagged or otherwise-tagged fences are prose.
- Git is the store. Text is the single source of truth; everything else (catalog, diagram, JSON export, the machine) is a projection.
- Comments: `#` to end of line. Docstrings: a string immediately after a declaration header.

```
model          := domain-decl statement*
domain-decl    := "domain" name [docstring] domain-clause*
domain-clause  := "mode" ("model-first" | "code-first" | "mixed")
                | "uses" lib-name+                 # library extensions, §11
                | key value                        # free metadata (state-of-record, fixtures, …)
statement      := concept | dimension | touchpoints | shape
                | exposure | action | invariant | scenario
```

## 2. Identifiers, IDs, handles

- `name`: `[a-z][a-zA-Z0-9_-]*` for keywords and values; `[A-Z][A-Za-z0-9]*` for declared Names.
- **Stable IDs** are authored in the text and never reassigned: `S001`, `A004`, `I003`, `SC001`. Prefix letters are conventional per kind, not enforced. Names may change; IDs may not. Cross-references use IDs or unambiguous Names. IDs are unique per domain (V1).
- **Handles**: `@name` — resolvable owners, validated against the repo's identity space (git contributors / CODEOWNERS / host config). Consumed by the questions inbox, staleness nudges, and review routing.

## 3. The expression language (total by construction)

No loops, no recursion, no user-defined functions, no side effects. Every expression terminates.

```
expr        := or
or          := and ("or" and)*
and         := unary ("and" unary)*
unary       := "not" unary | cmp
cmp         := sum [("=" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "not in") sum]
sum         := prod (("+" | "-") prod)*
prod        := atom (("*" | "/") atom)*
atom        := literal | path | context | "(" expr ")" | quantified
context     := "actor" "." ident | "today"
quantified  := ("no" | "some") ConceptRef ["where" expr]
path        := (ident | ConceptRef) ("." ident)*
literal     := int | decimal | string | duration | dimension-value
duration    := int unit      unit := "ms"|"s"|"m"|"h"|"d"|"week"|"month"|"year" [+"s"]
```

- Types: `int`, `decimal`, `string`, `bool`, `date`, `duration`, any dimension name, any concept name, `T?`. Paths type-check over declared fields (V4).
- **Resolution**: bare (lowercase-rooted) paths resolve against the subject — the shape's `of` or the action's subject. Capitalized-rooted paths resolve through the unique relation to that concept (`SubscriptionItem.price` from a Subscription subject). Quantifiers auto-scope through the quantified concept's unique subject-typed relation field; two candidate fields is an ambiguity error — write `where <field> = this` (`this` = the subject).
- **Context entities** — the kernel provides exactly two contextual facts about any evaluation: who acts (`actor.id`, `actor.role`) and what day it is (`today`, type `date`). Snapshot rule: within one evaluation, every read of a context entity sees the same value. Everything else is authored state.
- **Calendar arithmetic is kernel semantics**: `date ± N months` clamps to month end.
- **`.id`** is the kernel identity accessor, readable on any concept instance and on `actor`; apps never declare id fields. Identity comparisons (`actor.id = customer.id`) are the only bridge between roles (actor values) and entities (concepts).

## 4. Statement kinds — the kernel eight

Cross-cutting clauses usable on any statement: docstring · `note "…"` · `verified-by <path>[#case]` · `(planned)` · `undecided @handle "…"` (trailing after a line's content it attaches to that line; alone on a line it attaches to the enclosing statement or clause).

### 4.1 concept

```
concept-decl   := "concept" Name [docstring] concept-clause*
concept-clause := "dimension" name "=" value ("|" value)*      # concept-owned axis (trait)
                | "field" name ":" data-type                   # datum; data types only
                | "values" values-entry+
                | "fallback" string
data-type      := "int"|"decimal"|"string"|"bool"|"date"|"duration"|ConceptRef|data-type "?"
values-entry   := NAME [string] [marker]                       # line entries only (E52); string = per-value copy
```

- A **field** is a typed, observable property — never a storage or wire-schema mirror; declared only when a declaration consumes it. Derived-vs-stored is invisible to the model; when storage strategy is behaviorally load-bearing, state it as an invariant.
- **Relations** are concept-typed fields declared once, child-side; the one-to-many inverse is never authored — projections compute "has many".
- **Identity-only concepts** (name + docstring, no clauses) are legal — they type relations, feed the glossary, and grow. **Prohibition-only concepts** (declared solely to be `must-not-seen`, e.g. PaymentDetails) are legal — their detector binds in the mapping (§10).
- **`values`** declares enumerated instances that may carry field assignments — the DenyCode pattern: one code, one copy string, parameterized via `%placeholders%`; a code cannot exist without copy.
- **`fallback`** names the deterministic fallback for a judged-governed output (V7); it may also resolve through a copy-bearing `values` entry of a related concept.

### 4.2 dimension

```
dimension-decl := "dimension" name "=" value ("|" value)*      # domain-level: shared axes only
```

A `dimension` is a **classification axis** (what the subject *can be*); a `field` is a **datum** (what the subject *has*). Scope: concept-nested when owned by one concept, domain-level only when shared (promotion is a mechanical refactor). **Operational test**: can every possible value be written as a named domain word, such that adding or renaming one is a product decision? Yes → dimension; no → field. Corollary: a bool field whose two states carry domain meaning is a disguised two-value dimension (`payment_standing = clear | blocked`, not `payment_issue: bool`). Values are closed everywhere (V3); a domain-level dimension with ≤1 consumer is dead-or-nestable vocabulary.

### 4.3 touchpoints

```
touchpoints-decl := "touchpoints" lane+        lane := string
```

Names and order are authoritative — they are the diagram's lanes, nothing else. Which drivers and kits check a lane is computed from the mapping (set-valued, always current); dark lanes fall out of the same computation.

### 4.4 shape

```
shape-decl := "shape" [ID] Name ["of" ConceptRef] [docstring]
    "where" expr
    [fuse]
fuse := "wait" "[" ActionRef ("," ActionRef)* "]" "timeout" expr "->" ActionRef
```

Shapes are **pure predicates** — named, overlapping regions of the subject's state space; the state vocabulary consumed on both sides of the function (`requires`/`in` before an action, `->` after). Values are the state; shapes are views over it; nothing "enters" a shape — regions light up or go dark as effects move values. There are no authored transitions: **the machine is a projection**, computed from branch heads, gate refs, authored `->` claims, and landings derived from analyzable effects.

The **fuse** is the language's one temporal declaration: while the subject satisfies the region, a countdown of `timeout` runs; any listed action resets it; leaving the region disarms it; expiry fires the named system action (whose effects determine any landing).

### 4.5 exposure

```
exposure-decl := "exposure" ConceptRef
    ("to" actor "at" lane
        ("must-see" fact ("," fact)*)*
        ("must-not-see" fact ("," fact)*)* )+
fact := path | ConceptRef
```

The read-side kind: which facts must (and must not) reach which actor at which lane. `to` values belong to the actor dimension (machine roles included); `at` values are declared lanes. Claims are **sparse** over the actor×lane grid — unmentioned cells claim nothing; writes deny by default, reads oblige by declaration only. Facts: subject paths, related-concept paths (E31 auto-scope), or a bare ConceptRef (the related instances as a whole); a ConceptRef with no resolvable relation requires a mapping-bound detector. Check semantics: `must-see` is covered by ≥1 presence assertion on its lane (DOM + a11y tree for UI lanes — accessibility derives from the same declaration; payload presence for API lanes); `must-not-see` is **never DOM-checked** — it compiles to per-actor response scanning of all payloads served to that actor (suite runs and sampled prod traffic). Coverage audits run both ways: must-see without an asserting expectation = dark fact; expectations asserting undeclared visibility surface for adopt-or-drop.

### 4.6 action

```
action-decl    := "action" [ID] Name ["of" ConceptRef] [docstring]
    ["by" actor ("," actor)*]
    condition-line*
    actor-block*
    branch*
    [effect-block]
condition-line := "requires" (expr | ["not"] ShapeRef) ["else" CODE]
actor-block    := "by" actor ":" condition-line+
branch         := ("in" ShapeRef | "otherwise") ":" effect-block
effect-block   := "effect" effect-line+
effect-line    := delta | creation | outcome | sentence
delta          := path ("=" | "+=" | "-=") expr
creation       := "new" ConceptRef ["with" name "=" (value | expr) ("," name "=" (value | expr))*]
outcome        := "->" ShapeRef
```

- **Admission.** No `by` clause = system-triggered (webhooks, clocks, jobs); a `by` list = invocable by exactly those roles. There is no `anyone` — enumerate the dimension; a role added later is denied everywhere until admitted per-action. Deny-by-default is structural: an unlisted actor cannot act, and a failed condition without a code denies the built-in `FORBIDDEN`.
- **Conditions.** `requires … else CODE` — `else` targets resolve to values of the well-known `concept DenyCode`; copy lives only at the declaration. Conditions mentioning `actor.` must sit inside a `by <actor>:` block; universal lines never reference `actor.`; every block's actor must appear in the admission list.
- **Subject.** `of` pins it; otherwise it is the unique subject shared by all shape refs in the action's clauses; mixed subjects, or paths with no determinable subject, are errors.
- **Branches** evaluate first-match, top-down; branch bodies are effect content only.
- **Effects are the action's postcondition** — the model surrounds the function, never describes it (input contract in, outcome contract out; the Turing-complete function between them is implementation). A line is a delta iff it parses wholly as `path op expr`. A creation's unique subject-typed relation auto-binds to the acting subject. `->` is authored only where the outcome is opaque; where effects are analyzable, the landing is **derived**, never authored. Sentences are ref-anchored prose (three layers, §4.8) — the staged-verification path. **One home per claim**: a sentence restating deltas, creations, a derived landing, or a target shape's `where` is a duplicate and dies.

### 4.7 invariant

```
invariant-decl := "invariant" [ID] Name [docstring]
    ["check" "by" check-kind]
    ["rubric" string]                          # REQUIRED iff check by judged (V7)
check-kind := "schema" | "execution" | "scenario-coverage" | "conformance-only" | "judged"
```

Default `check by`: execution. Normative meanings:

| kind | true because… | covered when… |
| --- | --- | --- |
| `schema` | violation is unrepresentable (constraint/type) | the constraint exists |
| `execution` | every driven run shows it holding | ≥1 suite expectation is annotated `checks: [ID]`; replay/probes check expressible claims |
| `scenario-coverage` | the flows that could break it are exercised | its declared flow scenarios exist and pass |
| `conformance-only` | cross-system reconciliation keeps agreeing | the observer runs a reconciliation for it |
| `judged` | a rubric'd judge keeps passing outputs | rubric declared, judge wired, fallback declared |

Heuristic (normative for review): prefer the leftmost kind the invariant allows; an invariant sitting further right than necessary is a design-for-verification finding. Judged checks are labeled *judged* in every projection; the output they govern must declare a `fallback` (§4.1). Invariant claims are prose; adopted discovery candidates (§8) are authored the same way — adoption pins today's derivable truth as tomorrow's law.

### 4.8 scenario

```
scenario-decl := "scenario" [ID] Name ["(planned)"] [docstring]
    ("with" sentence)+                          # the world (setup)
    (step | expect-block | lane-line | checks-clause | verified-by | note)*
step          := sentence ["->" expectation]
expect-block  := "expect" (sentence | lane-line)+
lane-line     := "lane" string ":" sentence
checks-clause := "checks" InvariantRef ("," InvariantRef)*
expectation   := "denied" CODE | sentence
```

**Sentences span three layers.** Kernel grammar; vocabulary — Capitalized Names and IDs, which must resolve to declarations (V8); instance data — quoted strings, never linted ("Blue Mug", pinned dates like `with today "2026-02-28"`). Lowercase residue is unchecked prose; authors upgrade it by declaring the vocabulary and capitalizing the reference. `via <ActionID>` pins a step's action when the glossary can't resolve the verb unambiguously. Tests are the executable; scenarios are declarations audited structurally (§10).

## 5. (retired)

The provenance clause (`decided-by`) is deleted: who decided, when, and where is computed from git — the PR that introduced a line, the commit that removed its `undecided` marker, blame.

## 6. Modes and the (planned) marker

- Domain `mode` declares the leading artifact and sets drift blame: **code-first** — a red verdict accuses the declaration (production is presumed right); **model-first** — a red verdict accuses the implementation (the reviewed model is presumed right). Same suite, opposite burden of proof.
- `(planned)` on any statement is model-first content inside any mode: it compiles into the red/uncovered set, carries no `verified-by` (V10), and shipping it is removing the marker.

## 7. Well-formedness (validator obligations)

| # | Rule |
| --- | --- |
| V1 | IDs unique per domain |
| V2 | every reference resolves (shapes, actions, invariants, lanes, dimension values, deny codes, concepts) |
| V3 | dimension values closed; unknown value = error |
| V4 | predicates/effects type-check over declared fields; paths resolve |
| V5 | fuse: wait-list entries are declared actions; the timeout target is a declared system action |
| V6 | `else` targets are DenyCode values; every value carries copy |
| V7 | `check by judged` requires `rubric`; a governed output requires a resolvable `fallback` |
| V8 | sentence lint: unresolved Capitalized/ID tokens flagged; quoted strings exempt |
| V9 | an action's subject is determinable (`of`, or the unique subject of its shape refs); all shape refs share it |
| V10 | `(planned)` statements carry no `verified-by` |
| V11 | exposure facts resolve (subject path, related-concept path/ref); relationless concept-facts flagged as detector-required |
| V12 | machine sanity over the *computed* machine: unreachable shape = warning; dead region (unsatisfiable `where`) = warning |
| V13 | every `undecided` carries a resolvable `@handle` |
| V14 | `actor.`-conditions only inside actor blocks; block actors ⊆ the admission list |
| V15 | a kernel hook used without its well-known declaration = error (`by`/`to`/`actor.role` → `dimension actor`; `else`/`denied` → `concept DenyCode` with `copy: string`) |

Structural smells (warnings, not errors): domain dimension with ≤1 consumer · field with no writer · `*_id`-suffixed string field (a relation in costume) · bool field (disguised dimension) · declared-but-unreferenced shape/action/lane.

## 8. Toolchain semantics: validate → discover → align → probe/replay

All deterministic; no LLM sits in the checking path.

- **Witness** (per shape): small-scope search for one concrete world satisfying `where` — finite dimensions × small int ranges × boundary dates (month ends, clamping edges). Unsatisfiable = dead vocabulary.
- **Probe** (per authored `->` claim and per derivable landing): seed a witness of the source region, fire the branch's deltas and creations, evaluate the target's `where` on the result. Opaque effects report as *unprobeable* and join the partiality account.
- **Replay** (per scenario): seed the `with` world (context pins allowed), run the steps — gates → branch → deltas/creations — and check each `->` claim (denied codes, shape claims). Prose and lane expectations belong to the suite.
- **Discovery** (report-only): static dataflow over gates, branches, and effects deriving candidate invariants — theorems, near-theorems that localize which opaque effect blocks a proof, suspicious absences (fields no action writes), dead vocabulary. Candidates carry stable IDs; alignment is a human verdict per candidate (adopt / reject / mark-undecided); adopted candidates are authored as prose invariants — the pin is normativity, not information.
- **Partiality accounting**: every effect sentence and unprobeable claim is reported as declared-but-unverified; coverage never overstates.
- **The machine** (diagram, V12 sanity) is computed from branch heads, gate refs, authored `->` claims, and derived landings.
- **Time**: the virtual clock binds `today`; time advances only via explicit steps or pinned worlds; witness dates deliberately include calendar boundaries.

## 9. What is compiled vs authored

Compiled from the model: diagnostics, projections (catalog, diagram, JSON export, the machine), witness/probe/replay verdicts, discovery reports, audit reports, red sets for `(planned)` content. Authored by agents and humans, never generated by Meant Lang: application code, the interface layer, tests.

## 10. Companion: the mapping contract (TS, summarized)

```ts
defineSeed({ shape: "S001" })(fn)
defineAction({ action: "A004", actor: "customer" })(fn)
defineExpectation({ checks: ["I003"] } | { lane: "Orders API" } | { fact: "due_date" })(fn)
defineDetector({ concept: "PaymentDetails" })(fn)     // binds a prohibition-only concept to its scanner
catalogRef({ ids: ["A006", "SC001"] })                 // per test
```

Audits over the mapping (deterministic, part of the core): (1) **coverage**, both ways — declared-but-untested / tested-but-undeclared; (2) **faithfulness** — a test's effective world/steps derived from its annotated call sequence, diffed against the declared scenario; (3) **glossary** — interface-function names linted against model vocabulary. Trust principle: tests are generated freely; the faithfulness check is compiled — LLMs write what gets checked, never the checker.

## 11. Library extensions

New statement kinds and modalities ship as libraries (`uses`), never per-app inventions — and a library form must be a **deterministic macro over kernel semantics**: it expands to kernel constructs, and simulation and projections see only the expansion (e.g. a billing library's `cadence` expanding to actions, deltas, and fuses at ~3:1 density). No new analysis machinery may enter via a library; a library publishes its own inventory addition under §15's discipline. The kernel stays at eight kinds.

## 12. Conformance and subsetting

Any subset of kinds is a valid model; tools degrade gracefully (no shapes → no witnesses; no scenarios → no replay). A domain with no actor dimension is a valid system-only domain; a domain with no domain-level dimensions is common (all axes concept-owned). Minimum useful model: `concept` + one of {`scenario`, `invariant`}.

## 13. Non-goals (v0, explicit)

No persisted IR · no semantic patch API · no loops/recursion/user functions · no UI layout or page composition (exposure names facts, not pixels) · no prose-only requirements (unresolved vocabulary is flagged) · no temporal-logic operators or unbounded model checking (the altitude claim; `check by quint` reserved for a future library) · no time-of-day (refused at the recurrence bar — one consumer; `today` is date-resolution) · no LLM anywhere in the checking path.

## 14. Change log

The errata (E1–E55 folded into this body; new entries from E56) live in `spec/errata.md` — append-only; every grammar change lands there as an E# entry with a fixture.

## 15. Appendix: the kernel keyword inventory (normative)

The complete closed vocabulary of Meant Lang v0. **Any word not listed here, appearing in any model file, is application language** — the kind/instance test with no judgment calls. This list is the one-form rule's enforcement surface: adding a keyword requires amending this appendix, which requires an erratum.

```
kinds (8)      concept · dimension · touchpoints · shape · exposure
               · action · invariant · scenario
               (+ the domain wrapper)
domain         mode · uses · model-first · code-first · mixed
concept        field · values · fallback
shape          of · where · wait · timeout · ->        # the fuse: wait […] timeout <expr> -> ActionRef
exposure       to · at · must-see · must-not-see
action         of · by · requires · else · in · otherwise · effect · -> · new · with
invariant      check by · schema · execution · scenario-coverage
               conformance-only · judged · rubric
scenario       with · expect · lane · checks · via · -> · denied
cross-cutting  note · verified-by · (planned) · undecided @handle
expressions    and · or · not · in · no · some · where · this · duration units
               actor · today                            # the two context entities
```

**Well-known names** — the only app declarations whose *names* the kernel reserves; hooks bind by name, values stay app-owned: `dimension actor` (← by, to, actor.role) · `concept DenyCode` with `copy: string` (← else, denied, must-see). The table's shortness is its strength.

## 16. Open questions of this spec

- ~~OQ-spec-1~~ resolved (E45): no machine block — transitions deleted; the machine is a projection.
- OQ-spec-2: scenario sentences — how much structure before authoring burden exceeds audit value? Current bet: ref-anchoring + glossary lint only. (owner: @alex)
- ~~OQ-spec-3~~ resolved (E24): `rule` deleted; reusable predicates are shapes, the rest inlines.
- OQ-spec-4: `field` declarations — authored, or agent-inferred-and-recorded in code-first mode? Current bet: both, same syntax. (owner: @alex)
- OQ-spec-5: template invariants — which decidable claim forms (at-most-one, write-once, absorbing, bounded counter) earn a formal body and `check by derivation`? Evidence source: report-only discovery runs against application models. (owner: @alex)

## 17. Lexical layer (normative)

- UTF-8. Indentation is 2 spaces per level; tabs are illegal; INDENT/DEDENT are computed against a stack; blank lines and comment-only lines are indentation-neutral.
- `#` begins a comment to end of line (outside strings). Comments are trivia: preserved by tooling, never semantic.
- Strings are double-quoted and may span lines (docstrings, claims, rubric, copy). A quoted string is instance data in every operand position; string-typed clause positions (docstring, copy, rubric, fallback, lane names, free metadata values) are the only places a string is structural.
- A sentence occupies one logical line. A following line indented deeper than the sentence's first line, and not beginning a construct (a §15 keyword, `lane`, `->`, `new`, or a delta head), continues it.
- `undecided @handle "…"` trailing after a line's content attaches to that line; alone on a line it attaches to the enclosing statement or clause.
- Operand lists — `by`, `must-see`/`must-not-see`, `wait […]`, `new … with`, `checks` — are comma-separated on one line.
- Branch bodies are block-only: `in X :` / `otherwise :` followed by an indented block. There is no inline branch form.
- `values` entries are line entries — `NAME [string] [marker]`, one per line (E52); `|` is dimension-value syntax only.
- A path rooted at a Capitalized token is concept-rooted (resolves through the unique relation); a lowercase-rooted path resolves against the subject.
- Effect-line order is free: deltas, creations, outcomes, and sentences may interleave. Delta recognition is whole-line: a line is a delta iff it parses wholly as `path op expr`; near-misses (a sentence opening with `path op`) should be linted as probably-intended deltas.
- `.md` hosting: tooling extracts fenced code blocks whose info string is `meant` and reports diagnostics against host-file positions; all other fences (untagged or otherwise-tagged) are prose. Formatting inside `.md` hosts touches only extracted regions.
