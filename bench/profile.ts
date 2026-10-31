/**
 * One scenario in a tight loop, for a profiler to look at:
 *
 *   node --cpu-prof bench/profile.ts match
 *   bun bench/profile.ts match
 *
 * Scenarios: parse, compile, match, urls, escaped.
 * To see bytes allocated per operation, give Node a young generation big enough
 * that no collection lands inside the measurement:
 *
 *   node --max-semi-space-size=512 bench/profile.ts match
 */
import { parse } from "../src/index.ts";
import { canonicalRequestPath } from "../src/url.ts";
import { loadCorpus } from "./workload.ts";

const scenario = process.argv[2] ?? "match";
const seconds = Number(process.argv[3] ?? 4);
const sites = loadCorpus();
const agents = sites.map((site) => parse(site.text).agent("Googlebot"));
let sink = 0;

const scenarios: Record<string, () => number> = {
  parse() {
    for (const site of sites) sink += parse(site.text).sitemaps.length;
    return sites.length;
  },
  compile() {
    for (const site of sites)
      sink += parse(site.text).agent("Googlebot").isAllowedPath("/") ? 1 : 0;
    return sites.length;
  },
  match() {
    let count = 0;
    for (let i = 0; i < sites.length; i++) {
      const agent = agents[i] as (typeof agents)[number];
      const { paths } = sites[i] as (typeof sites)[number];
      for (let j = 0; j < paths.length; j++)
        sink += agent.isAllowedPath(paths[j] as string) ? 1 : 0;
      count += paths.length;
    }
    return count;
  },
  urls() {
    let count = 0;
    for (const { urls } of sites) {
      for (let j = 0; j < urls.length; j++) {
        sink += canonicalRequestPath(urls[j] as string).length;
      }
      count += urls.length;
    }
    return count;
  },
  escaped() {
    let count = 0;
    for (let i = 0; i < sites.length; i++) {
      const agent = agents[i] as (typeof agents)[number];
      const { escapedPaths } = sites[i] as (typeof sites)[number];
      for (let j = 0; j < escapedPaths.length; j++) {
        sink += agent.isAllowedPath(escapedPaths[j] as string) ? 1 : 0;
      }
      count += escapedPaths.length;
    }
    return count;
  },
};

const run = scenarios[scenario];
if (run === undefined) throw new Error(`Unknown scenario ${scenario}`);

const end = performance.now() + seconds * 1000;
let operations = 0;
const start = performance.now();
while (performance.now() < end) operations += run();
const elapsed = performance.now() - start;

let allocation = "";
if (!("Bun" in globalThis)) {
  const before = process.memoryUsage().heapUsed;
  const measured = run();
  const bytes = (process.memoryUsage().heapUsed - before) / measured;
  // A negative figure means a collection ran, so it says nothing.
  allocation = bytes >= 0 ? `, ${bytes.toFixed(1)} bytes/op` : "";
}
console.log(
  `${scenario}: ${((elapsed * 1e6) / operations).toFixed(1)} ns/op${allocation}, sink ${sink}`,
);
