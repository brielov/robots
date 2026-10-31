/**
 * Runs the benchmark in several fresh processes and prints each row's median
 * and range, since one process can't tell a small change from noise.
 *
 * Non-overlapping ranges are a rank test: at 5 processes against 5, a false alarm
 * has a chance of about 0.8% per row, so across hundreds of rows expect one or
 * two. "Within noise" is conservative, so read the median change too, and use
 * more processes when a change matters.
 *
 *   bun bench/spread.ts [runs] [bun|node|both] [--only=<text>] [--save=<file>]
 *                       [--against=<file>]
 */
import type { Row } from "./run.ts";

const flags = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const runs = Number(positional[0] ?? 5);
const target = positional[1] ?? "both";
const option = (name: string): string | undefined =>
  flags.find((flag) => flag.startsWith(`--${name}=`))?.slice(name.length + 3);

const script = new URL("./run.ts", import.meta.url).pathname;
const passThrough = [
  "--no-baseline",
  "--json",
  ...flags.filter((flag) => flag.startsWith("--only=")),
];

type Summary = Record<string, { median: number; low: number; high: number; unit: string }>;

interface Run {
  runtime: string;
  corpus: string;
  rows: Row[];
}

interface Saved {
  runtime: string;
  corpus: string;
  summary: Summary;
}

async function runOnce(command: string): Promise<Run> {
  const child = Bun.spawn([command, script, ...passThrough], { stdout: "pipe", stderr: "inherit" });
  const output = await new Response(child.stdout).text();
  await child.exited;
  return JSON.parse(output.trim().split("\n").pop() as string) as Run;
}

const format = (ns: number): string =>
  ns >= 1000 ? `${(ns / 1000).toFixed(2)} µs` : `${ns.toFixed(ns >= 10 ? 1 : 2)} ns`;

const previous: Record<string, Saved> | undefined =
  option("against") === undefined
    ? undefined
    : ((await Bun.file(option("against") as string).json()) as Record<string, Saved>);
const saved: Record<string, Saved> = {};

for (const command of target === "both" ? ["bun", "node"] : [target]) {
  const samples = new Map<string, { values: number[]; unit: string }>();
  let identity: { runtime: string; corpus: string } | undefined;
  for (let run = 0; run < runs; run++) {
    const result = await runOnce(command);
    if (identity !== undefined && identity.corpus !== result.corpus) {
      throw new Error("The corpus changed between processes.");
    }
    identity = { runtime: result.runtime, corpus: result.corpus };
    for (const { suite, label, unit, ns } of result.rows) {
      const key = `${suite} | ${label}`;
      const entry = samples.get(key) ?? { values: [], unit };
      entry.values.push(ns);
      samples.set(key, entry);
    }
  }

  if (identity === undefined) throw new Error("No runs.");
  const baseline = previous?.[command];
  if (baseline !== undefined && baseline.corpus !== identity.corpus) {
    throw new Error(`Corpus differs: saved ${baseline.corpus}, now ${identity.corpus}.`);
  }
  if (baseline !== undefined && baseline.runtime !== identity.runtime) {
    throw new Error(`Runtime differs: saved ${baseline.runtime}, now ${identity.runtime}.`);
  }

  console.log(`\n${identity.runtime}, ${runs} processes, corpus ${identity.corpus}`);
  const summary: Summary = {};
  for (const [key, { values, unit }] of samples) {
    values.sort((a, b) => a - b);
    const median = values[values.length >> 1] as number;
    const low = values[0] as number;
    const high = values[values.length - 1] as number;
    summary[key] = { median, low, high, unit };

    const before = baseline?.summary[key];
    let change = "";
    if (before !== undefined) {
      const percent = ((median - before.median) / before.median) * 100;
      const overlap = low <= before.high && high >= before.low;
      change = `  ${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%${overlap ? " (within noise)" : ""}`;
    }
    console.log(
      `${key.padEnd(62)} ${format(median).padStart(11)} [${format(low)} - ${format(high)}] ${unit}${change}`,
    );
  }
  saved[command] = { ...identity, summary };
}

const save = option("save");
if (save !== undefined) await Bun.write(save, JSON.stringify(saved, null, 2));
