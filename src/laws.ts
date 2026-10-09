import type { Diagnostic, Range, Severity } from "./diagnostics";
import type { Token } from "./lexer";
import { tokenRange, KEYWORDS } from "./lexer";
import type { Condition, EffectBlock, Expr, Marker, Sentence } from "./cst";
import type { ResolvedModel, Sink } from "./resolve";

/**
 * Law codes are API — agents and goldens key on them.
 * V# are the spec §7 validator obligations. L-# are structural smells (info, never errors):
 * L-id-string · L-bool · L-no-writer · L-unref-shape · L-unref-action · L-unref-lane
 * L-dim-single-consumer · L-near-miss-delta · L-keyword-shadow · L-detector-required
 */
export type Law = (m: ResolvedModel) => Diagnostic[];

/** Where a finding points: a domain spans files, so a range never travels without its file. */
interface Located { file: string; range: Range }

function make() {
  const out: Diagnostic[] = [];
  const at = (t: Token): Located => ({ file: t.file, range: tokenRange(t, t) });
  const emit = (law: string, code: string, severity: Severity, message: string, where: Located, fix?: string) => {
    out.push({ law, code, severity, message, file: where.file, range: where.range, ...(fix ? { fix } : {}) });
  };
  return { out, at, emit };
}

// ---------------------------------------------------------------- walkers

function* allEffectBlocks(m: ResolvedModel): Generator<{ block: EffectBlock; subject: string | null; file: string }> {
  for (const action of m.actionList) {
    const subject = m.subjects.get(action) ?? null;
    if (action.effect) yield { block: action.effect, subject, file: action.file };
    for (const b of action.branches) if (b.effect) yield { block: b.effect, subject, file: action.file };
  }
}

function* allConditions(m: ResolvedModel): Generator<{ condition: Condition; subject: string | null; inActorBlock: boolean; file: string }> {
  for (const action of m.actionList) {
    const subject = m.subjects.get(action) ?? null;
    for (const c of action.conditions) yield { condition: c, subject, inActorBlock: false, file: action.file };
    for (const b of action.actorBlocks) for (const c of b.conditions) yield { condition: c, subject, inActorBlock: true, file: action.file };
  }
}

function* allSentences(m: ResolvedModel): Generator<{ sentence: Sentence; file: string }> {
  for (const { block, file } of allEffectBlocks(m)) {
    for (const line of block.lines) if (line.kind === "sentence") yield { sentence: line.sentence, file };
  }
  for (const sc of m.scenarios) {
    const file = sc.file;
    for (const w of sc.worlds) yield { sentence: w, file };
    for (const s of sc.steps) {
      yield { sentence: s.sentence, file };
      if (s.expectation?.kind === "sentence") yield { sentence: s.expectation.sentence, file };
    }
    for (const e of sc.expects) {
      for (const s of e.sentences) yield { sentence: s, file };
      for (const l of e.lanes) for (const s of l.sentences) yield { sentence: s, file };
    }
    for (const l of sc.lanes) for (const s of l.sentences) yield { sentence: s, file };
  }
}

function* allMarkers(m: ResolvedModel): Generator<{ marker: Marker; file: string }> {
  for (const st of m.model.statements) for (const marker of st.common.markers) yield { marker, file: st.file };
  if (m.model.domain) for (const marker of m.model.domain.common.markers) yield { marker, file: m.model.domain.file };
  for (const info of m.concepts.values()) for (const v of info.decl.values) if (v.marker) yield { marker: v.marker, file: info.decl.file };
  for (const { condition, file } of allConditions(m)) if (condition.marker) yield { marker: condition.marker, file };
  for (const { block, file } of allEffectBlocks(m)) {
    for (const line of block.lines) {
      if (line.kind !== "sentence" && line.marker) yield { marker: line.marker, file };
    }
  }
  for (const { sentence, file } of allSentences(m)) if (sentence.marker) yield { marker: sentence.marker, file };
}

function contextRoots(expr: Expr | null, found: Token[]): void {
  if (!expr) return;
  switch (expr.kind) {
    case "context": if (expr.root.text === "actor") found.push(expr.root); return;
    case "binary": contextRoots(expr.left, found); contextRoots(expr.right, found); return;
    case "unary": contextRoots(expr.operand, found); return;
    case "paren": contextRoots(expr.inner, found); return;
    case "quantified": contextRoots(expr.where, found); return;
    default: return;
  }
}

// ---------------------------------------------------------------- laws

const v1UniqueDeclarations: Law = m => {
  const { out, at, emit } = make();
  for (const dup of m.duplicates) {
    emit("V1", "duplicate-declaration", "error",
      `\`${dup.token.text}\` is already declared in this domain, at ${dup.first.file}:${dup.first.pos.line} (V1: names and IDs are unique).`,
      at(dup.token), "rename the second declaration, or delete it");
  }
  return out;
};

const v2ReferencesResolve: Law = m => {
  const { out, at, emit } = make();
  const missing = (t: Token, code: string, message: string, fix: string) => {
    const hint = m.elsewhere(t.text);
    emit("V2", code, "error", `${message}${hint?.note ?? ""}`, at(t), hint?.fix ?? fix);
  };
  const shapeRef = (t: Token) => {
    if (!m.shapes.has(t.text)) missing(t, "unresolved-ref",
      `\`${t.text}\` is not a declared shape.`, `declare \`shape ${t.text}\` or fix the reference`);
  };
  const actionRef = (t: Token) => {
    if (!m.actions.has(t.text)) missing(t, "unresolved-ref",
      `\`${t.text}\` is not a declared action.`, `declare \`action ${t.text}\` or fix the reference`);
  };
  const conceptRef = (t: Token) => {
    if (!m.concepts.has(t.text)) missing(t, "unresolved-ref",
      `\`${t.text}\` is not a declared concept.`, `declare \`concept ${t.text}\` or fix the reference`);
  };
  const laneRef = (t: Token) => {
    if (!m.lanes.has(t.value)) emit("V2", "unresolved-ref", "error",
      `"${t.value}" is not a declared touchpoint lane.`, at(t), "add the lane to `touchpoints`");
  };
  const denyRef = (t: Token) => {
    if (t.text === "FORBIDDEN") return;               // the kernel's built-in default code (E27)
    if (!m.denyCodes?.values.has(t.text)) emit("V2", "unresolved-ref", "error",
      `\`${t.text}\` is not a declared DenyCode value.`, at(t), "add it under `concept DenyCode`'s `values`");
  };

  for (const shape of m.shapeList) {
    if (shape.of) conceptRef(shape.of);
  }
  for (const info of m.concepts.values()) {
    for (const f of info.decl.fields) {
      const t = f.type.name;
      const known = m.concepts.has(t.text) || m.domainDimensions.has(t.text)
        || ["int", "decimal", "string", "bool", "date", "duration"].includes(t.text);
      if (!known) missing(t, "unresolved-type",
        `\`${t.text}\` is not a data type or a declared concept (§4.1).`,
        `declare \`concept ${t.text}\`, or use int/decimal/string/bool/date/duration`);
    }
  }
  for (const { condition } of allConditions(m)) {
    if (condition.shape) shapeRef(condition.shape);
    if (condition.elseCode) denyRef(condition.elseCode);
  }
  for (const action of m.actionList) for (const b of action.branches) if (b.shape) shapeRef(b.shape);
  for (const { block } of allEffectBlocks(m)) {
    for (const line of block.lines) {
      if (line.kind === "outcome") shapeRef(line.shape);
      if (line.kind === "creation") conceptRef(line.concept);
    }
  }
  for (const exposure of m.model.statements) {
    if (exposure.kind !== "exposure") continue;
    conceptRef(exposure.concept);
    for (const b of exposure.blocks) laneRef(b.lane);
  }
  for (const sc of m.scenarios) {
    for (const c of sc.checks) {
      if (!m.invariants.has(c.text)) missing(c, "unresolved-ref",
        `\`${c.text}\` is not a declared invariant.`, `declare \`invariant ${c.text}\``);
    }
    for (const l of sc.lanes) laneRef(l.lane);
    for (const e of sc.expects) for (const l of e.lanes) laneRef(l.lane);
    for (const step of sc.steps) {
      if (step.sentence.via) actionRef(step.sentence.via);
      if (step.expectation?.kind === "denied") denyRef(step.expectation.code);
      if (step.expectation?.kind === "shape") shapeRef(step.expectation.shape);
    }
    for (const w of sc.worlds) if (w.via) actionRef(w.via);
  }
  return out;
};

const v3v4Expressions: Law = m => {
  const { out } = make();
  for (const shape of m.shapeList) {
    const subject = shape.of?.text ?? null;
    const sink: Sink = { file: shape.file, out };
    if (shape.where) m.typeOf(shape.where, subject, sink);
    if (shape.fuse) m.typeOf(shape.fuse.timeout, subject, sink);
  }
  for (const { condition, subject, file } of allConditions(m)) {
    if (condition.expr) m.typeOf(condition.expr, subject, { file, out });
  }
  for (const { block, subject, file } of allEffectBlocks(m)) {
    const sink: Sink = { file, out };
    for (const line of block.lines) {
      if (line.kind === "delta") m.checkDelta(line.path, line.op, line.expr, subject, sink);
      if (line.kind === "creation") {
        for (const a of line.assignments) m.checkMemberAssignment(line.concept, a.name, a.expr, subject, sink);
      }
    }
  }
  return out;
};

const v5Fuse: Law = m => {
  const { out, at, emit } = make();
  for (const shape of m.shapeList) {
    const fuse = shape.fuse;
    if (!fuse) continue;
    for (const trigger of fuse.triggers) {
      if (!m.actions.has(trigger.text)) emit("V5", "unresolved-fuse-trigger", "error",
        `\`${trigger.text}\` is in the wait list but is not a declared action (V5).`,
        at(trigger), `declare \`action ${trigger.text}\`, or drop it from the list`);
    }
    if (!m.actions.has(fuse.target.text)) {
      emit("V5", "unresolved-fuse-target", "error",
        `The fuse fires \`${fuse.target.text}\`, which is not a declared action (V5/E50).`,
        at(fuse.target), `declare \`action ${fuse.target.text}\``);
      continue;
    }
    const target = m.actions.get(fuse.target.text);
    if (target && (target.by.length > 0 || target.actorBlocks.length > 0)) {
      emit("V5", "fuse-target-not-system", "error",
        `The fuse fires \`${fuse.target.text}\`, which is invocable by ${target.by.map(b => b.text).join(", ")} — a timeout fires a system action (E50).`,
        at(fuse.target), "drop the `by` list, or fire a system action");
    }
  }
  return out;
};

const v6DenyCodes: Law = m => {
  const { out, at, emit } = make();
  const deny = m.denyCodes;
  if (!deny) return out;
  for (const entry of deny.values.values()) {
    if (entry.copy === null) {
      emit("V6", "deny-code-without-copy", "error",
        `\`${entry.name.text}\` carries no copy — a code cannot exist without its message (E27).`,
        at(entry.name), 'add the message: `CODE "…"`');
    }
  }
  return out;
};

const v7JudgedNeedsRubric: Law = m => {
  const { out, at, emit } = make();
  for (const inv of m.invariantList) {
    if (inv.checkBy?.text === "judged" && inv.rubric === null) {
      emit("V7", "judged-without-rubric", "error",
        `\`${inv.name.text}\` is checked by judgment but declares no \`rubric\`.`,
        at(inv.checkBy), "add a `rubric \"…\"` line stating what fails");
    }
    if (inv.checkBy && !["schema", "execution", "scenario-coverage", "conformance-only", "judged"].includes(inv.checkBy.text)) {
      emit("V2", "unknown-check-kind", "error",
        `\`${inv.checkBy.text}\` is not a check kind (§4.7).`, at(inv.checkBy),
        "use schema, execution, scenario-coverage, conformance-only, or judged");
    }
  }
  return out;
};

const v8SentenceLint: Law = m => {
  const { out, at, emit } = make();
  const known = new Set<string>();
  for (const name of m.concepts.keys()) known.add(name);
  for (const name of m.shapes.keys()) known.add(name);
  for (const name of m.actions.keys()) known.add(name);
  for (const name of m.invariants.keys()) known.add(name);
  for (const sc of m.scenarios) { known.add(sc.name.text); if (sc.id) known.add(sc.id.text) }
  for (const info of m.concepts.values()) for (const v of info.values.keys()) known.add(v);
  for (const { sentence } of allSentences(m)) {
    for (const ref of sentence.refs) {
      if (known.has(ref.text)) continue;
      emit("V8", "unresolved-sentence-ref", "error",
        `\`${ref.text}\` is used as vocabulary but resolves to no declaration (V8).`,
        at(ref), `declare it, or lowercase it to mark it honestly unverified prose`);
    }
  }
  return out;
};

const v9Subjects: Law = m => m.subjectDiagnostics;

const v10PlannedCarriesNoProof: Law = m => {
  const { out, emit } = make();
  for (const st of m.model.statements) {
    if (!st.common.planned) continue;
    const name = "name" in st ? st.name.text : st.kind;
    for (const v of st.common.verifiedBy) {
      emit("V10", "planned-with-verified-by", "error",
        `\`${name}\` is \`(planned)\` — planned content compiles into the red set and carries no \`verified-by\` (§6).`,
        { file: st.file, range: v.range }, "remove the marker to ship it, or drop the anchor");
    }
  }
  return out;
};

const v11ExposureFacts: Law = m => {
  const { out, at, emit } = make();
  for (const st of m.model.statements) {
    if (st.kind !== "exposure") continue;
    const subject = st.concept.text;
    const info = m.concepts.get(subject);
    if (!info) continue;
    for (const block of st.blocks) {
      for (const fact of [...block.mustSee, ...block.mustNotSee]) {
        const head = fact.path[0];
        if (!head) continue;
        if (head.kind === "NAME" || head.kind === "ID") {
          if (!m.concepts.has(head.text)) {
            emit("V11", "unresolved-fact", "error",
              `\`${head.text}\` is not a declared concept — an exposure fact is a path or a ConceptRef (E40).`,
              at(head), `declare \`concept ${head.text}\``);
            continue;
          }
          if (fact.path.length === 1) {
            if (m.relationRoute(subject, head.text) === "none") {
              emit("V11", "detector-required", "info",
                `\`${head.text}\` has no relation to ${subject} — the mapping must bind its detector (E40, §10).`,
                at(head), `add \`defineDetector({ concept: "${head.text}" })\` in the mapping`);
            }
            continue;
          }
          m.resolvePath(fact.path, subject, { file: st.file, out });
          continue;
        }
        if (fact.path.length === 1) {
          if (!info.fields.has(head.text) && !info.dimensions.has(head.text)) {
            emit("V11", "unresolved-fact", "error",
              `\`${head.text}\` is not a field or dimension of ${subject} (V11).`,
              at(head), `declare it on \`concept ${subject}\`, or fix the fact`);
          }
          continue;
        }
        m.resolvePath(fact.path, subject, { file: st.file, out });
      }
    }
  }
  return out;
};

const v13MarkersCarryOwners: Law = m => {
  const { out, emit } = make();
  for (const { marker, file } of allMarkers(m)) {
    if (marker.handle === null) {
      emit("V13", "marker-without-handle", "error",
        "An `undecided` marker names its owner — `undecided @handle \"…\"` (E18/E19).",
        { file, range: marker.range }, "add the owner handle");
    }
  }
  return out;
};

const v14ActorScoping: Law = m => {
  const { out, at, emit } = make();
  for (const action of m.actionList) {
    for (const condition of action.conditions) {
      const roots: Token[] = [];
      contextRoots(condition.expr, roots);
      for (const root of roots) {
        emit("V14", "actor-condition-universal", "error",
          "A condition mentioning `actor.` lives in a `by <actor>:` block — a universal line silently binds every future actor (E48).",
          at(root), "move the line into an actor block");
      }
    }
    const admitted = new Set(action.by.map(b => b.text));
    for (const block of action.actorBlocks) {
      if (!admitted.has(block.actor.text)) {
        emit("V14", "block-actor-not-admitted", "error",
          `\`${block.actor.text}\` heads an actor block but is not in this action's admission list (E48).`,
          at(block.actor), `add \`${block.actor.text}\` to \`by\`, or drop the block`);
      }
    }
  }
  return out;
};

const v15WellKnownNames: Law = m => {
  const { out, at, emit } = make();
  const needActor: Token[] = [];
  const needDeny: Token[] = [];
  for (const action of m.actionList) {
    for (const b of action.by) needActor.push(b);
    for (const block of action.actorBlocks) needActor.push(block.actor);
  }
  for (const st of m.model.statements) if (st.kind === "exposure") for (const b of st.blocks) needActor.push(b.actor);
  for (const { condition } of allConditions(m)) {
    const roots: Token[] = [];
    contextRoots(condition.expr, roots);
    needActor.push(...roots);
    if (condition.elseCode) needDeny.push(condition.elseCode);
  }
  for (const sc of m.scenarios) for (const s of sc.steps) if (s.expectation?.kind === "denied") needDeny.push(s.expectation.code);

  if (m.actorDimension === null) {
    for (const t of needActor) {
      emit("V15", "missing-actor-dimension", "error",
        "`by` / `to` / `actor.` bind to the well-known `dimension actor`, which this domain never declares (E34).",
        at(t), "declare `dimension actor = …`, or drop the hook (a system-only domain is legal)");
    }
  } else {
    const values = new Set(m.actorDimension.values.map(v => v.text));
    for (const t of needActor) {
      if (t.kind === "HANDLE" || t.text === "actor") continue;
      if (!values.has(t.text)) {
        emit("V3", "unknown-actor-value", "error",
          `\`${t.text}\` is not a value of \`dimension actor\` (${[...values].join(" | ")}).`,
          at(t), "add the role to the actor dimension, or use a declared one");
      }
    }
  }

  const deny = m.denyCodes;
  const denyHasCopy = deny ? [...deny.fields.values()].some(f => f.name.text === "copy" && f.type.k === "string") : false;
  if (needDeny.length > 0 && (!deny || !denyHasCopy)) {
    for (const t of needDeny) {
      emit("V15", "missing-deny-code-concept", "error",
        "`else` / `denied` bind to the well-known `concept DenyCode` carrying `field copy: string`, which this domain never declares (E34).",
        at(t), "declare `concept DenyCode` with `field copy: string` and its `values`");
    }
  }
  return out;
};

// ---------------------------------------------------------------- structural smells (info)

const smells: Law = m => {
  const { out, at, emit } = make();
  const info = (code: string, message: string, where: Located, fix: string) =>
    emit(code, code, "info", message, where, fix);

  for (const conceptInfo of m.concepts.values()) {
    const owner = conceptInfo.decl.name.text;
    for (const field of conceptInfo.decl.fields) {
      const type = conceptInfo.fields.get(field.name.text);
      if (type?.type.k === "bool") {
        info("L-bool", `\`${field.name.text}\` is a bool — when its two states carry domain meaning it is a disguised two-value dimension (E30).`,
          at(field.name), `consider \`dimension ${field.name.text} = … | …\``);
      }
      if (/_id$/.test(field.name.text) && type?.type.k === "string") {
        info("L-id-string", `\`${field.name.text}\` is an id-shaped string — a relation in costume (E35).`,
          at(field.name), "declare the concept-typed relation and compare identities with `.id`");
      }
      if (!m.writes.has(`${owner}.${field.name.text}`)) {
        info("L-no-writer", `No action writes \`${owner}.${field.name.text}\`.`,
          at(field.name), "declare the action that moves it, or drop the field");
      }
    }
    for (const dim of conceptInfo.decl.dimensions) {
      if (KEYWORDS.has(dim.name.text) && dim.name.text !== "actor") {
        info("L-keyword-shadow", `\`${dim.name.text}\` is a §15 kernel keyword used as app vocabulary.`,
          at(dim.name), "rename it so the kind/instance test stays free of judgment calls");
      }
    }
    for (const field of conceptInfo.decl.fields) {
      if (KEYWORDS.has(field.name.text)) {
        info("L-keyword-shadow", `\`${field.name.text}\` is a §15 kernel keyword used as app vocabulary.`,
          at(field.name), "rename the field");
      }
    }
  }

  // references, for the declared-but-unreferenced smells
  const usedShapes = new Set<string>();
  const usedActions = new Set<string>();
  const usedLanes = new Set<string>();
  for (const { condition } of allConditions(m)) if (condition.shape) usedShapes.add(condition.shape.text);
  for (const action of m.actionList) for (const b of action.branches) if (b.shape) usedShapes.add(b.shape.text);
  for (const { block } of allEffectBlocks(m)) for (const line of block.lines) if (line.kind === "outcome") usedShapes.add(line.shape.text);
  for (const shape of m.shapeList) if (shape.fuse) {
    for (const t of shape.fuse.triggers) usedActions.add(t.text);
    usedActions.add(shape.fuse.target.text);
  }
  for (const sc of m.scenarios) {
    for (const l of sc.lanes) usedLanes.add(l.lane.value);
    for (const e of sc.expects) for (const l of e.lanes) usedLanes.add(l.lane.value);
    for (const s of [...sc.steps.map(s => s.sentence), ...sc.worlds]) {
      if (s.via) usedActions.add(s.via.text);
      for (const ref of s.refs) { usedShapes.add(ref.text); usedActions.add(ref.text) }
    }
  }
  for (const { sentence: s } of allSentences(m)) for (const ref of s.refs) { usedShapes.add(ref.text); usedActions.add(ref.text) }
  for (const st of m.model.statements) if (st.kind === "exposure") for (const b of st.blocks) usedLanes.add(b.lane.value);

  for (const shape of m.shapeList) {
    if (shape.fuse) continue;                       // a fuse is machinery on the region — self-consuming
    if (usedShapes.has(shape.name.text) || (shape.id && usedShapes.has(shape.id.text))) continue;
    info("L-unref-shape", `\`${shape.name.text}\` is declared but never referenced.`,
      at(shape.name), "gate an action on it, branch on it, or delete it");
  }
  for (const action of m.actionList) {
    if (usedActions.has(action.name.text) || (action.id && usedActions.has(action.id.text))) continue;
    info("L-unref-action", `\`${action.name.text}\` is declared but never referenced by a scenario, fuse, or sentence.`,
      at(action.name), "exercise it in a scenario, or delete it");
  }
  for (const [lane, token] of m.lanes) {
    if (usedLanes.has(lane)) continue;
    info("L-unref-lane", `Lane "${lane}" is declared but carries no exposure claim or expectation — a dark lane.`,
      at(token), "claim a fact on it, or drop it from `touchpoints`");
  }

  for (const [name, dim] of m.domainDimensions) {
    if (name !== "actor") continue;
    let consumers = 0;
    for (const action of m.actionList) { if (action.by.length > 0) consumers++; consumers += action.actorBlocks.length }
    for (const st of m.model.statements) if (st.kind === "exposure") consumers += st.blocks.length;
    if (consumers <= 1) {
      info("L-dim-single-consumer", `\`dimension ${name}\` has ${consumers} consumer — dead-or-nestable vocabulary (§4.2).`,
        at(dim.name), "consume it, or delete it");
    }
  }

  for (const { block, file } of allEffectBlocks(m)) {
    for (const line of block.lines) {
      if (line.kind === "sentence" && line.nearMiss) {
        info("L-near-miss-delta", "This sentence opens like a delta (`path op …`) but does not parse as one (§17).",
          { file, range: line.range }, "make it a delta, or reword so it does not read as one");
      }
    }
  }
  return out;
};

export const LAWS: ReadonlyArray<Law> = [
  v1UniqueDeclarations,
  v2ReferencesResolve,
  v3v4Expressions,
  v5Fuse,
  v6DenyCodes,
  v7JudgedNeedsRubric,
  v8SentenceLint,
  v9Subjects,
  v10PlannedCarriesNoProof,
  v11ExposureFacts,
  v13MarkersCarryOwners,
  v14ActorScoping,
  v15WellKnownNames,
  smells,
];

export function runLaws(m: ResolvedModel): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const law of LAWS) out.push(...law(m));
  return out;
}
