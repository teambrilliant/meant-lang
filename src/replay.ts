import type { Verdict } from "./diagnostics";
import type { Expr, ScenarioDecl, Sentence } from "./cst";
import type { Token } from "./lexer";
import { joinTokens } from "./lexer";
import type { ResolvedModel } from "./resolve";
import type { Value, World } from "./eval";
import { durationOf, holds, parseDate } from "./eval";
import { addInstance, context, fire, shapeDecl } from "./store";
import { witness } from "./witness";
import type { ProbeContext } from "./probe";
import { bindOwner, subjectInstance } from "./probe";

/**
 * Replay drives a scenario's declared world through its steps. What it will not do is guess:
 * a step whose action cannot be resolved from `via` or an exact action name is reported unresolved,
 * lane and prose expectations are reported skipped (they are the suite's), `checks` is reported as
 * the prose claim it is, and the clock never advances on its own — "three days pass" is residue,
 * not a fuse the replay is entitled to fire.
 */

interface Fragment { tokens: Token[] }

/** `with A, B "x", path = v` — one world line carries several claims, comma-separated (§17). */
function fragments(sentence: Sentence): Fragment[] {
  const out: Fragment[] = [];
  let current: Token[] = [];
  for (const token of sentence.tokens) {
    if (token.kind === "OP" && token.text === ",") { if (current.length) out.push({ tokens: current }); current = []; continue }
    current.push(token);
  }
  if (current.length) out.push({ tokens: current });
  return out;
}

function literalValue(token: Token | undefined): Value | null {
  if (!token) return null;
  if (token.kind === "INT") return { t: "int", n: Number(token.text) };
  if (token.kind === "DECIMAL") return { t: "decimal", n: Number(token.text) };
  if (token.kind === "STRING") return { t: "string", s: token.value };
  if (token.kind === "DURATION") { const d = durationOf(token.text); return d.t === "duration" ? d : null }
  if (token.kind === "IDENT" || token.kind === "NAME" || token.kind === "KEYWORD") return { t: "word", w: token.text };
  return null;
}

interface Seed {
  shapes: string[];
  concepts: string[];
  pins: Array<{ path: string[]; value: Value }>;
  today: Extract<Value, { t: "date" }> | null;
  residue: string[];
}

function readSeed(scenario: ScenarioDecl, model: ResolvedModel): Seed {
  const seed: Seed = { shapes: [], concepts: [], pins: [], today: null, residue: [] };
  for (const sentence of scenario.worlds) {
    for (const fragment of fragments(sentence)) {
      const tokens = fragment.tokens;
      const first = tokens[0];
      if (!first) continue;

      if (first.text === "today" && tokens[1]?.kind === "STRING") {
        const pinned = parseDate(tokens[1]?.value ?? "");
        if (pinned.t === "date") { seed.today = pinned; continue }
      }

      const equals = tokens.findIndex(t => t.kind === "OP" && t.text === "=");
      if (equals > 0) {
        const path = tokens.slice(0, equals).filter(t => !(t.kind === "OP" && t.text === ".")).map(t => t.text);
        const value = literalValue(tokens[equals + 1]);
        if (value && path.length > 0 && tokens.length === equals + 2) { seed.pins.push({ path, value }); continue }
      }

      const shape = tokens.find(t => model.shapes.has(t.text));
      if (shape) {
        seed.shapes.push(shape.text);
        const rest = joinTokens(tokens.filter(t => t !== shape)).trim();
        if (rest !== "") seed.residue.push(rest);
        continue;
      }
      const concept = tokens.find(t => model.concepts.has(t.text));
      if (concept) {
        seed.concepts.push(concept.text);
        const rest = joinTokens(tokens.filter(t => t !== concept)).trim();
        if (rest !== "") seed.residue.push(rest);
        continue;
      }
      seed.residue.push(joinTokens(tokens));
    }
  }
  return seed;
}

/** The role a step names, if any: a value of the well-known `dimension actor` appearing in it. */
function actorOf(sentence: Sentence, model: ResolvedModel): string | null {
  const values = new Set((model.actorDimension?.values ?? []).map(v => v.text));
  for (const token of sentence.tokens) if (values.has(token.text)) return token.text;
  return null;
}

function actionOf(sentence: Sentence, model: ResolvedModel) {
  if (sentence.via) return model.actions.get(sentence.via.text) ?? null;
  for (const ref of sentence.refs) {
    const action = model.actions.get(ref.text);
    if (action) return action;
  }
  return null;
}

export function replayScenarios(ctx: ProbeContext): Verdict[] {
  const { model } = ctx;
  const out: Verdict[] = [];

  for (const scenario of model.scenarios) {
    const file = scenario.file;
    const label = scenario.id?.text ?? scenario.name.text;
    const seed = readSeed(scenario, model);
    const shapeWheres: Array<Expr | null> = seed.shapes.map(s => shapeDecl(model, s)?.where ?? null);
    const subjectConcept =
      seed.shapes.map(s => shapeDecl(model, s)?.of?.text ?? null).find(c => c !== null)
      ?? seed.concepts[0] ?? null;

    if (subjectConcept === null) {
      out.push({
        kind: "replay", subject: label, status: "skipped",
        message: "the `with` world names no shape or concept to seed a subject from.",
        file, range: scenario.range,
      });
      continue;
    }

    const found = witness({
      model, subjectConcept, require: shapeWheres, pins: seed.pins,
      ...(seed.today ? { today: seed.today } : {}),
      scope: ctx.base, budget: ctx.budget,
    });
    if (!found.world) {
      out.push({
        kind: "replay", subject: label, status: "dead",
        message: `no world satisfies the \`with\` clause (${seed.shapes.join(", ") || "pins only"}) within scope — the scenario's own setup is unsatisfiable.`,
        file, range: scenario.range,
      });
      continue;
    }

    let world: World = found.world;
    for (const concept of seed.concepts) {
      if (world.instances.some(i => i.concept === concept)) continue;
      const created = addInstance(world, concept);
      const back = [...(model.concepts.get(concept)?.fields ?? new Map())]
        .find(([, f]) => f.type.k === "concept" && f.type.name === subjectConcept);
      const subject = subjectInstance(world, subjectConcept);
      if (back && subject) created.members.set(back[0], { t: "ref", id: subject.id });
    }
    for (const residue of seed.residue) {
      out.push({
        kind: "replay", subject: `${label}#with`, status: "skipped",
        message: `world residue not seeded: "${residue}" — instance data and prose reach the suite, not the kernel.`,
        file, range: scenario.range,
      });
    }

    let stepNumber = 0;
    for (const step of scenario.steps) {
      stepNumber++;
      const stepLabel = `${label}#${stepNumber}`;
      const text = joinTokens(step.sentence.tokens);
      const action = actionOf(step.sentence, model);
      if (!action) {
        out.push({
          kind: "replay", subject: stepLabel, status: "skipped",
          message: `no action resolves from "${text}" — replay takes \`via <Action>\` or an exact action name, and never advances the clock on its own.`,
          file, range: step.range,
        });
        continue;
      }
      const role = actorOf(step.sentence, model);
      const actionSubject = model.subjects.get(action) ?? null;
      const target = actionSubject === null ? null : subjectInstance(world, actionSubject);
      if (!target) {
        out.push({
          kind: "replay", subject: stepLabel, status: "skipped",
          message: `\`${action.name.text}\` acts on ${actionSubject ?? "an undeterminable subject"}, and this world holds no such instance.`,
          file, range: step.range,
        });
        continue;
      }

      bindOwner(action, model, world, target.id, role);
      const fired = fire(action, model, world, target.id, role);

      if (fired.admissionMismatch) {
        out.push({
          kind: "replay", subject: stepLabel, status: "falsified",
          message: fired.admissionMismatch,
          file, range: step.range,
          evidence: [`the scenario has ${role} invoking it; either add \`by ${role}\` or the step is wrong`],
        });
      }

      const expectation = step.expectation;
      if (fired.admissionMismatch) {
        // The step cannot happen as written, so nothing downstream of it is worth a verdict.
        if (!fired.denied) world = fired.world;
        continue;
      }
      if (expectation === null) {
        out.push({
          kind: "replay", subject: stepLabel, status: fired.denied ? "falsified" : "verified",
          message: fired.denied
            ? `\`${action.name.text}\` is denied \`${fired.denied.code}\` here (${fired.denied.reason}), but the step claims it proceeds.`
            : `\`${action.name.text}\` fires${fired.branch ? ` through \`${fired.branch}\`` : ""}.`,
          file, range: step.range,
        });
      } else if (expectation.kind === "denied") {
        const expected = expectation.code.text;
        const actual = fired.denied?.code ?? null;
        out.push({
          kind: "replay", subject: stepLabel, status: actual === expected ? "verified" : "falsified",
          message: actual === expected
            ? `denied \`${expected}\` (${fired.denied?.reason ?? ""}).`
            : `expected \`denied ${expected}\`, got ${actual === null ? "a successful firing" : `\`${actual}\``}.`,
          file, range: expectation.range,
          evidence: [actual === null ? "denied nothing" : `denied ${actual}`],
        });
      } else if (expectation.kind === "shape") {
        const shape = shapeDecl(model, expectation.shape.text);
        const verdict = shape ? holds(shape.where, context(model, fired.world, target.id)) : null;
        out.push({
          kind: "replay", subject: stepLabel, status: verdict === true ? "verified" : verdict === false ? "falsified" : "unprobeable",
          message: verdict === true
            ? `lands in \`${expectation.shape.text}\`.`
            : verdict === false
              ? `does not land in \`${expectation.shape.text}\` after \`${action.name.text}\`.`
              : `\`${expectation.shape.text}\` cannot be decided on the post-state.`,
          file, range: expectation.range,
        });
      } else {
        out.push({
          kind: "replay", subject: stepLabel, status: "skipped",
          message: `prose expectation "${joinTokens(expectation.sentence.tokens)}" — the suite asserts this, not the kernel.`,
          file, range: expectation.range,
        });
      }

      for (const line of fired.opaque) {
        out.push({
          kind: "replay", subject: stepLabel, status: "unprobeable",
          message: `effect sentence not executed: "${line.text}".`,
          file: action.file, range: line.range,
        });
      }
      if (!fired.denied) world = fired.world;
    }

    for (const block of scenario.expects) {
      for (const sentence of block.sentences) {
        out.push({
          kind: "replay", subject: `${label}#expect`, status: "skipped",
          message: `prose expectation "${joinTokens(sentence.tokens)}" — suite territory (§4.8).`,
          file, range: sentence.range,
        });
      }
      for (const lane of block.lanes) {
        out.push({
          kind: "replay", subject: `${label}#expect`, status: "skipped",
          message: `lane expectation on "${lane.lane.value}" — lane checks are computed from the mapping, not from replay (§4.5).`,
          file, range: lane.range,
        });
      }
    }
    for (const lane of scenario.lanes) {
      out.push({
        kind: "replay", subject: `${label}#lane`, status: "skipped",
        message: `lane expectation on "${lane.lane.value}" — lane checks are computed from the mapping, not from replay (§4.5).`,
        file, range: lane.range,
      });
    }
    for (const invariant of scenario.checks) {
      out.push({
        kind: "replay", subject: `${label}#checks`, status: "skipped",
        message: `\`${invariant.text}\` is a prose invariant — replay reports coverage, it does not enforce the claim (§4.7).`,
        file, range: scenario.range,
      });
    }
  }
  return out;
}
