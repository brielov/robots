/**
 * Runs on Bun and Node alike, because they use different engines and most
 * production users are on V8. Node needs a version with type stripping on by
 * default (23.6 or later).
 *
 *   bun bench/run.ts
 *   node bench/run.ts
 *
 * `--no-baseline` skips robots-parser, `--json` prints rows as JSON for
 * bench/spread.ts, and `--only=<text>` runs the suites with that in their name.
 *
 * A single process can't see small changes: the same code can land up to about
 * 17% apart between processes. Compare with `bun bench/spread.ts`.
 */
import { parse } from "../src/index.ts";
import { canonicalRequestPath } from "../src/url.ts";
import { corpusHash, loadCorpus, loadSynthetic, type Site } from "./workload.ts";

const AGENT = "Googlebot";
const ROUNDS = 15;
const TARGET_MS = 40;
const WARMUP_MS = 500;

const json = process.argv.includes("--json");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7);

/** Kept alive and printed, so no work can be optimized away. */
let sink = 0;

export interface Row {
  suite: string;
  label: string;
  unit: string;
  ns: number;
}

const rows: Row[] = [];

function print(text: string): void {
  if (!json) console.log(text);
}

function format(ns: number): string {
  if (ns >= 1000) return `${(ns / 1000).toFixed(2)} µs`;
  return ns >= 10 ? `${ns.toFixed(1)} ns` : `${ns.toFixed(2)} ns`;
}

function row(suite: string, label: string, unit: string, ns: number, note = ""): void {
  rows.push({ suite, label, unit, ns });
  print(`  ${label.padEnd(40)} ${format(ns).padStart(12)} ${unit}${note}`);
}

/** Times `run`, which does `operations` units of work, returning ns per unit. */
function measure(operations: number, run: () => void): number {
  let repeats = 0;
  const warmupStart = performance.now();
  while (performance.now() - warmupStart < WARMUP_MS) {
    run();
    repeats++;
  }

  // Size rounds from warmed-up speed, not from the cold first pass.
  let sized = performance.now();
  run();
  sized = performance.now() - sized;
  repeats = Math.max(1, Math.ceil(TARGET_MS / Math.max(sized, 0.001)));

  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const start = performance.now();
    for (let i = 0; i < repeats; i++) run();
    samples.push(((performance.now() - start) * 1e6) / (repeats * operations));
  }
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1] as number;
}

type Baseline = (
  url: string,
  text: string,
) => { isAllowed(url: string, agent: string): boolean | undefined };

/** Rewrites every rule to `disallow`, so being denied means a rule matched. */
function allDisallow(text: string): string {
  return text.replace(/^(\s*)allow(\s*:)/gim, "$1disallow$2");
}

interface Split {
  hits: string[][];
  misses: string[][];
}

function splitByHit(sites: readonly Site[]): Split {
  const hits: string[][] = [];
  const misses: string[][] = [];
  for (const site of sites) {
    const agent = parse(allDisallow(site.text)).agent(AGENT);
    hits.push(site.paths.filter((path) => !agent.isAllowedPath(path)));
    misses.push(site.paths.filter((path) => agent.isAllowedPath(path)));
  }
  return { hits, misses };
}

function matchRow(
  suite: string,
  label: string,
  agents: readonly ReturnType<ReturnType<typeof parse>["agent"]>[],
  lists: readonly string[][],
): void {
  const count = lists.reduce((total, list) => total + list.length, 0);
  if (count === 0) return;
  row(
    suite,
    label,
    "per URL",
    measure(count, () => {
      for (let i = 0; i < agents.length; i++) {
        const agent = agents[i] as (typeof agents)[number];
        const list = lists[i] as string[];
        for (let j = 0; j < list.length; j++) {
          sink += agent.isAllowedPath(list[j] as string) ? 1 : 0;
        }
      }
    }),
  );
}

function perFileSpread(
  suite: string,
  agents: readonly ReturnType<ReturnType<typeof parse>["agent"]>[],
  sites: readonly Site[],
): void {
  if (sites.length < 5) return;
  const costs: number[] = [];
  for (let i = 0; i < sites.length; i++) {
    const agent = agents[i] as (typeof agents)[number];
    const { paths } = sites[i] as Site;
    let done = 0;
    const start = performance.now();
    do {
      for (let j = 0; j < paths.length; j++)
        sink += agent.isAllowedPath(paths[j] as string) ? 1 : 0;
      done += paths.length;
    } while (performance.now() - start < 5);
    costs.push(((performance.now() - start) * 1e6) / done);
  }
  costs.sort((a, b) => a - b);
  row(suite, "isAllowedPath, median file", "per URL", costs[costs.length >> 1] as number);
  row(
    suite,
    "isAllowedPath, p95 file",
    "per URL",
    costs[Math.floor(costs.length * 0.95)] as number,
  );
}

function printShape(sites: readonly Site[], split: Split): void {
  const total = sites.reduce((sum, site) => sum + site.paths.length, 0);
  const hits = split.hits.reduce((sum, list) => sum + list.length, 0);
  let queries = 0;
  let escapes = 0;
  for (const site of sites) {
    for (const path of site.paths) {
      if (path.includes("?")) queries++;
      if (path.includes("%")) escapes++;
    }
  }
  const share = (count: number): string => `${((count / total) * 100).toFixed(1)}%`;
  print(`  shape: ${share(hits)} rule hits, ${share(queries)} queries, ${share(escapes)} escapes`);
}

function runSuite(suite: string, sites: readonly Site[], baseline: Baseline | undefined): void {
  if (sites.length === 0 || (only !== undefined && !suite.includes(only))) return;
  const urlCount = sites.reduce((total, site) => total + site.urls.length, 0);
  const bytes = sites.reduce((total, site) => total + site.bytes.length, 0);
  print(`\n${suite}: ${sites.length} files, ${(bytes / 1024).toFixed(0)} KiB, ${urlCount} URLs`);

  const split = splitByHit(sites);
  printShape(sites, split);

  const parseString = measure(bytes, () => {
    for (const site of sites) sink += parse(site.text).sitemaps.length;
  });
  row(suite, "parse string", "per byte", parseString);
  row(
    suite,
    "parse bytes",
    "per byte",
    measure(bytes, () => {
      for (const site of sites) sink += parse(site.bytes).sitemaps.length;
    }),
  );

  // First use is the fair headline: robots-parser does its rule work up front,
  // while this library defers it, so parse time alone compares different work.
  const firstMatch = measure(sites.length, () => {
    for (const site of sites) sink += parse(site.text).agent(AGENT).isAllowedPath("/") ? 1 : 0;
  });
  row(suite, "first use (parse + compile + decide)", "per file", firstMatch);
  row(
    suite,
    "  of which compile + decide (derived)",
    "per file",
    firstMatch - (parseString * bytes) / sites.length,
  );

  const agents = sites.map((site) => parse(site.text).agent(AGENT));
  const pathLists = sites.map((site) => site.paths);
  matchRow(suite, "isAllowedPath", agents, pathLists);
  perFileSpread(suite, agents, sites);
  matchRow(suite, "isAllowedPath, rule hits only", agents, split.hits);
  matchRow(suite, "isAllowedPath, misses only", agents, split.misses);
  matchRow(
    suite,
    "isAllowedPath, escaped URLs",
    agents,
    sites.map((site) => site.escapedPaths),
  );
  row(
    suite,
    "isAllowed",
    "per URL",
    measure(urlCount, () => {
      for (let i = 0; i < sites.length; i++) {
        const agent = agents[i] as (typeof agents)[number];
        const { urls } = sites[i] as Site;
        for (let j = 0; j < urls.length; j++) sink += agent.isAllowed(urls[j] as string) ? 1 : 0;
      }
    }),
  );
  row(
    suite,
    "URL handling alone",
    "per URL",
    measure(urlCount, () => {
      for (const site of sites) {
        const { urls } = site;
        for (let j = 0; j < urls.length; j++) {
          sink += canonicalRequestPath(urls[j] as string).length;
        }
      }
    }),
  );

  if (baseline === undefined) return;
  row(
    suite,
    "robots-parser: first use",
    "per file",
    measure(sites.length, () => {
      for (const site of sites) {
        const origin = `https://www.${site.name}`;
        sink += baseline(`${origin}/robots.txt`, site.text).isAllowed(`${origin}/`, AGENT) ? 1 : 0;
      }
    }),
  );
  const instances = sites.map((site) => baseline(`https://www.${site.name}/robots.txt`, site.text));
  row(
    suite,
    "robots-parser: isAllowed",
    "per URL",
    measure(urlCount, () => {
      for (let i = 0; i < sites.length; i++) {
        const instance = instances[i] as ReturnType<Baseline>;
        const { urls } = sites[i] as Site;
        for (let j = 0; j < urls.length; j++) {
          sink += instance.isAllowed(urls[j] as string, AGENT) ? 1 : 0;
        }
      }
    }),
  );
}

async function loadBaseline(): Promise<Baseline | undefined> {
  if (process.argv.includes("--no-baseline")) return undefined;
  const module = (await import("robots-parser")) as unknown as { default: Baseline };
  return module.default;
}

const runtime = "Bun" in globalThis ? `Bun ${process.versions.bun}` : `Node ${process.version}`;
const baseline = await loadBaseline();
const corpus = loadCorpus();
print(`${runtime}, agent "${AGENT}", corpus ${corpusHash(corpus)}`);
if (corpus.length === 0) print("\nNo corpus; run `bun run bench:corpus` for real files.");
runSuite("real files", corpus, baseline);

for (const site of loadSynthetic()) {
  // Skipped only to keep the run short.
  const skipBaseline = /near-miss|final-segment|10k/.test(site.name);
  runSuite(site.name, [site], skipBaseline ? undefined : baseline);
}

if (json) console.log(JSON.stringify({ runtime, corpus: corpusHash(corpus), rows }));
else console.log(`\nsink ${sink}`);
