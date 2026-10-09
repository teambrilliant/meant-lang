import type { ResolvedModel } from "./resolve";
import type { Value, World } from "./eval";
import { toDayNumber } from "./eval";
import { BASE_DATE, cloneWorld } from "./store";

/**
 * Greedy minimization, shared by every counterexample reporter. A counterexample is only useful
 * when a human can hold it in their head: `count = 4, n = 2` teaches what `count = 5, n = 2,
 * failed_billing_count = 7, next_ship_date = 2028-02-29` does not.
 *
 * The contract is one-directional — `holds` is re-asked after every candidate simplification, and
 * only simplifications it still accepts are kept. Shrinking can never turn a real counterexample
 * into a fake one.
 */

const dimensionValues = (model: ResolvedModel, concept: string, member: string): string[] => {
  const info = model.concepts.get(concept);
  const own = info?.dimensions.get(member);
  if (own) return own.values.map(v => v.text);
  const shared = model.domainDimensions.get(member);
  return shared ? shared.values.map(v => v.text) : [];
};

/** Candidate simplifications of one value, simplest first. */
function simpler(model: ResolvedModel, concept: string, member: string, value: Value): Value[] {
  switch (value.t) {
    case "int": case "decimal": {
      const out: Value[] = [];
      for (const n of [0, 1, Math.floor(value.n / 2), value.n - 1]) {
        if (n >= 0 && n < value.n && !out.some(v => (v.t === "int" || v.t === "decimal") && v.n === n)) {
          out.push({ t: value.t, n } as Value);
        }
      }
      return out;
    }
    case "date":
      return toDayNumber(value.y, value.m, value.d) === toDayNumber(BASE_DATE.y, BASE_DATE.m, BASE_DATE.d) ? [] : [BASE_DATE];
    case "duration":
      return value.months === 0 && value.days <= 1 ? [] : [{ t: "duration", months: 0, days: 1 }];
    case "string":
      return value.s === "" ? [] : [{ t: "string", s: "" }];
    case "word": {
      const values = dimensionValues(model, concept, member);
      const at = values.indexOf(value.w);
      return at <= 0 ? [] : values.slice(0, at).map(w => ({ t: "word", w } as Value));
    }
    default: return [];
  }
}

export function shrinkWorld(world: World, model: ResolvedModel, subjectId: string | null, holds: (w: World) => boolean): World {
  let best = cloneWorld(world);
  if (!holds(best)) return world;

  for (let pass = 0; pass < 6; pass++) {
    let improved = false;

    // Instances first — dropping one removes every member it contributed.
    for (const instance of [...best.instances]) {
      if (instance.id === subjectId) continue;
      const candidate = cloneWorld(best);
      candidate.instances = candidate.instances.filter(i => i.id !== instance.id);
      for (const other of candidate.instances) {
        for (const [member, value] of other.members) {
          if (value.t === "ref" && value.id === instance.id) other.members.set(member, { t: "ref", id: null });
        }
      }
      if (holds(candidate)) { best = candidate; improved = true }
    }

    for (const instance of best.instances) {
      for (const [member, value] of [...instance.members]) {
        for (const candidateValue of simpler(model, instance.concept, member, value)) {
          const candidate = cloneWorld(best);
          candidate.instances.find(i => i.id === instance.id)?.members.set(member, candidateValue);
          if (holds(candidate)) { best = candidate; improved = true; break }
        }
      }
    }

    if (!improved) break;
  }
  return best;
}

/**
 * Shorten a step sequence from the front: the shortest prefix-free suffix that still exhibits the
 * failure is the one worth printing. Used by replay, whose counterexamples are sequences, not worlds.
 */
export function shrinkSteps<T>(steps: T[], holds: (s: T[]) => boolean): T[] {
  let best = steps;
  for (let i = 0; i < steps.length; i++) {
    const candidate = best.slice(1);
    if (candidate.length > 0 && holds(candidate)) best = candidate; else break;
  }
  for (let i = best.length - 1; i >= 0; i--) {
    const candidate = [...best.slice(0, i), ...best.slice(i + 1)];
    if (candidate.length > 0 && holds(candidate)) best = candidate;
  }
  return best;
}
