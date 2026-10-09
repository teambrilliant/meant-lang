# Contributing to Meant Lang

Meant is a developer preview. Bug reports, small fixes, and evidence from real models are the most useful contributions.

## Reporting a problem

Open an issue with the bug-report template: the first line `meant` prints, the command you ran, the smallest model that reproduces it, and the output. Remove anything private from the model first.

## Changing the toolkit

```bash
bun install          # dev tooling only (TypeScript for typechecking)
bun test             # goldens, round-trip, fixture EXPECT/SIM-EXPECT harnesses, site freshness
bun run typecheck
```

- **The spec is the authority.** `spec/meant-grammar-v0.md` is normative. Where spec and code disagree, the spec wins. Where the spec is ambiguous, open an issue proposing an erratum rather than picking a generous reading in code.
- **Fixtures carry their expectations.** A new rule or fix lands with a fixture in `fixtures/` that plants it: `# EXPECT: <law>` on the offending line, or `# SIM-EXPECT: falsified <claim-id>` · `dead <Shape>` · `denied <CODE>` for simulation. `fixtures/known-good.meant` must stay at zero errors and zero warnings.
- **Diagnostic law and code strings, and verdict statuses, are API.** Agents and goldens key on them; changing one is a recorded decision, not a rename.
- **Zero runtime dependencies.** Any new dependency, runtime or dev, needs agreement in an issue first.
- **Derived files are generated.** `.claude/skills/meant-modeling/SKILL.md` comes from `src/skill.md` (`bun run meant skill install`); `site/skill.md`, `site/spec.md`, `site/llms-full.txt` and the example's recorded result come from `bun scripts/site.ts`. Tests fail when either is stale.

## Changing the language

New syntax clears a recurrence bar: the pattern appears at least twice, independently, ideally in different domains. One-off patterns stay prose. A proposal names the checker or declaration that will consume the new form; a form nothing consumes is not added.

## License

By contributing you agree that your contribution is licensed under the [MIT license](LICENSE).
