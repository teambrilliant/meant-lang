import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { siteFiles } from "../scripts/site";

/**
 * The website publishes files derived from the CLI and the spec — the skill, the grammar, a
 * recorded `meant sim --json` run, llms-full.txt. A change to any source must fail here, not
 * leave the site quietly serving stale instructions to agents. Regenerate: bun scripts/site.ts
 */
for (const [path, content] of siteFiles()) {
  test(`derived site file is current: ${path} (regenerate: bun scripts/site.ts)`, () => {
    expect(readFileSync(path, "utf8")).toBe(content);
  });
}

// ---------------------------------------------------------------- what a fetcher receives

const ORIGIN = "https://meantlang.dev";
const PAGES = readdirSync("site", { recursive: true, encoding: "utf8" })
  .filter(file => file.endsWith(".html"))
  .map(file => ({ file: `site/${file}`, url: ORIGIN + "/" + file.replace(/(^|\/)index\.html$/, "$1"), html: readFileSync(`site/${file}`, "utf8") }));

test("every page carries the head an agent or link preview reads", () => {
  for (const { file, url, html } of PAGES) {
    const required: Array<{ name: string; pattern: RegExp }> = [
      { name: "description", pattern: /<meta name="description" content="[^"]+">/ },
      { name: "canonical", pattern: new RegExp(`<link rel="canonical" href="${url}">`) },
      { name: "og:url", pattern: new RegExp(`<meta property="og:url" content="${url}">`) },
      { name: "og:title", pattern: /<meta property="og:title" content="[^"]+">/ },
      { name: "og:description", pattern: /<meta property="og:description" content="[^"]+">/ },
      { name: "twitter:card", pattern: /<meta name="twitter:card" content="[^"]+">/ },
    ];
    const missing = required.filter(({ pattern }) => !pattern.test(html)).map(({ name }) => `${file}: ${name}`);
    expect(missing).toEqual([]);
  }
});

test("structured data parses and names schema.org", () => {
  const blocks = PAGES.flatMap(({ html }) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => m[1] ?? ""));
  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) expect(JSON.parse(block)["@context"]).toBe("https://schema.org");
});

test("headings read as text when line breaks are dropped (no `word<br>word`)", () => {
  const glued = PAGES.flatMap(({ file, html }) =>
    [...html.matchAll(/<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/g)].filter(m => /\S<br>/.test(m[2] ?? "")).map(m => `${file}: ${m[0]}`));
  expect(glued).toEqual([]);
});

/** Where `href` on `fromFile` points inside site/, or null when it leaves the site. */
function siteTarget(href: string, fromFile: string): { file: string; fragment: string } | null {
  const local = href.startsWith(ORIGIN) ? href.slice(ORIGIN.length) || "/" : href;
  const [path = "", fragment = ""] = local.split("#");
  if (path === "") return { file: fromFile, fragment };
  if (!path.startsWith("/")) return null;
  return { file: `site${path.endsWith("/") ? `${path}index.html` : path}`, fragment };
}

test("every internal link and #fragment resolves (pages, llms.txt, sitemap.xml)", () => {
  const sources = [
    ...PAGES.map(({ file, html }) => ({ file, links: [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(m => m[1] ?? "") })),
    { file: "site/llms.txt", links: [...readFileSync("site/llms.txt", "utf8").matchAll(/\]\(([^)]+)\)/g)].map(m => m[1] ?? "") },
    { file: "site/sitemap.xml", links: [...readFileSync("site/sitemap.xml", "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1] ?? "") },
  ];
  const broken: string[] = [];
  for (const { file, links } of sources) {
    for (const href of links) {
      const target = siteTarget(href, file);
      if (target === null) continue;
      if (!existsSync(target.file)) { broken.push(`${file}: ${href} (no ${target.file})`); continue }
      if (target.fragment !== "" && !readFileSync(target.file, "utf8").includes(`id="${target.fragment}"`)) broken.push(`${file}: ${href} (no id)`);
    }
  }
  expect(broken).toEqual([]);
});

// ---------------------------------------------------------------- one story across the site

const PROMPT = "Run `meant` and follow its instructions to build a Meant model of the <workflow> workflow in this app.";

test("the start-from-code prompt reads the same on the landing page, the docs, and llms.txt", () => {
  const html = PROMPT.replace("<", "&lt;").replace(">", "&gt;");
  expect(readFileSync("site/index.html", "utf8")).toContain(html);
  expect(readFileSync("site/docs/index.html", "utf8")).toContain(html);
  expect(readFileSync("site/llms.txt", "utf8")).toContain(PROMPT);
});

test("no page contradicts the public install", () => {
  const stale = PAGES.flatMap(({ file, html }) =>
    ["bun run meant", "no public installable package", "not yet available", "development checkout"].filter(phrase => html.includes(phrase)).map(phrase => `${file}: ${phrase}`));
  expect(stale).toEqual([]);
});
