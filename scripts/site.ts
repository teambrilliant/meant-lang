import { readFileSync, writeFileSync } from "node:fs";
import { renderSkill, specAll } from "../src/onboarding";
import { simulate } from "../src/sim";

const EXAMPLE_MODEL = "site/examples/invoicing.meant";

/**
 * Every site file derived from repo sources, keyed by repo-relative path (run from the repo root).
 * Hand-written pages quote these; tests/site.test.ts fails when one on disk is stale.
 */
export function siteFiles(): Map<string, string> {
  const skill = renderSkill("stdout");
  const spec = specAll();
  const llms = readFileSync("site/llms.txt", "utf8");
  const model = readFileSync(EXAMPLE_MODEL, "utf8");
  return new Map([
    ["site/skill.md", skill],
    ["site/spec.md", spec],
    ["site/examples/invoicing.result.json", JSON.stringify(simulate([EXAMPLE_MODEL]), null, 2) + "\n"],
    ["site/llms-full.txt", [llms, skill, spec, `# Example model: ${EXAMPLE_MODEL.replace("site/", "/")}\n\n\`\`\`meant\n${model}\`\`\`\n`].join("\n---\n\n")],
  ]);
}

if (import.meta.main) {
  for (const [path, content] of siteFiles()) writeFileSync(path, content);
}
