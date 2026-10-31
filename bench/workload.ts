/**
 * Builds the benchmark inputs. Everything is seeded, so two runs measure the
 * same work. The URLs come from each file's own rules, because random URLs
 * would hardly ever reach anything but the first few rules.
 */
import { readdirSync, readFileSync } from "node:fs";

export interface Site {
  name: string;
  text: string;
  bytes: Uint8Array;
  /** Absolute URLs. */
  urls: string[];
  /** The same requests as path plus query. */
  paths: string[];
  /** Longer variants of those requests, percent-encoded the way forms encode them. */
  escapedPaths: string[];
}

function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

/** Identifies the corpus, which is gitignored, so runs on different ones don't get compared. */
export function corpusHash(sites: readonly Site[]): string {
  let combined = 0;
  for (const { name, text } of sites) combined = (combined ^ hashText(name + text)) >>> 0;
  return combined.toString(16).padStart(8, "0");
}

/** mulberry32. */
function createRandom(seed: number): (limit: number) => number {
  let state = seed;
  return (limit) => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) % limit;
  };
}

const COMMON_PATHS = [
  "/",
  "/about",
  "/blog/2026/10/some-article-title",
  "/products/widget-1234?ref=home&utm_source=newsletter",
  "/search?q=robots+txt&page=3",
  "/en-us/help/getting-started",
  "/category/shoes/running?sort=price",
  "/users/alice/settings",
  "/assets/img/logo.png",
  "/news/world/europe-68123456",
];

function pathFromRule(pattern: string, random: (limit: number) => number): string {
  const literal = pattern.replaceAll("*", "x").replace(/\$$/, "");
  const path = literal.startsWith("/") ? literal : `/${literal}`;
  return random(2) === 0 ? path : `${path}more/of-the-path?id=${random(1000)}`;
}

/**
 * Draws from every group in the file, not just the benchmarked agent's, so some
 * URLs are unrelated to the rules being scanned. That is true of a real crawl.
 * The 70% share of rule-derived URLs is a choice; the benchmark prints the
 * resulting hit rate, and reports hits and misses separately.
 */
function buildPaths(text: string, count: number, seed: number): string[] {
  const random = createRandom(seed);
  const patterns = [...text.matchAll(/^\s*(?:dis)?allow\s*:\s*([^\s#]+)/gim)].map(
    (match) => match[1] as string,
  );
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const fromRule = patterns.length > 0 && random(10) < 7;
    paths.push(
      fromRule
        ? pathFromRule(patterns[random(patterns.length)] as string, random)
        : (COMMON_PATHS[random(COMMON_PATHS.length)] as string),
    );
  }
  return paths;
}

function escapePath(path: string): string {
  const queryStart = path.indexOf("?");
  const head = queryStart < 0 ? path : path.slice(0, queryStart);
  const query = queryStart < 0 ? "" : path.slice(queryStart);
  return `${head}/caf%c3%a9%7Epage${query === "" ? "?next=%2Fhome%3Fa%3D1" : `${query}&next=%2Fhome`}`;
}

function site(name: string, text: string, urlCount: number, bytes?: Uint8Array): Site {
  const paths = buildPaths(text, urlCount, hashText(name));
  return {
    name,
    text,
    bytes: bytes ?? new TextEncoder().encode(text),
    paths,
    escapedPaths: paths.map(escapePath),
    urls: paths.map((path) => `https://www.${name}${path}`),
  };
}

export function loadCorpus(urlCount = 200): Site[] {
  const directory = new URL("./corpus/", import.meta.url);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".txt"));
  } catch {
    names = [];
  }
  return names
    .sort()
    .map((name) =>
      site(name.slice(0, -4), readFileSync(new URL(name, directory), "utf8"), urlCount),
    );
}

/** Shapes a large or adversarial file might take. */
export function loadSynthetic(): Site[] {
  const manyPrefixes = (count: number): string => {
    const random = createRandom(7);
    let text = "user-agent: *\n";
    for (let i = 0; i < count; i++) {
      text += `${random(2) === 0 ? "allow" : "disallow"}: /section-${random(50)}/page-${i}/\n`;
    }
    return text;
  };
  const wildcards = (count: number): string => {
    let text = "user-agent: *\n";
    for (let i = 0; i < count; i++) text += `disallow: /*a*b*c*d*e-${i}*f$\n`;
    return text;
  };
  const finalSegments = (count: number): string => {
    let text = "user-agent: *\n";
    for (let i = 0; i < count; i++) text += `disallow: /*a*b*c*d*e-*z${i}\n`;
    return text;
  };
  const manyGroups = (count: number): string => {
    let text = "";
    for (let i = 0; i < count; i++) text += `user-agent: bot-${i}\ndisallow: /private-${i}/\n\n`;
    return `${text}user-agent: *\ndisallow: /admin/\n`;
  };
  const queryEscapes = (count: number): string => {
    let text = "user-agent: *\n";
    for (let i = 0; i < count; i++) text += `disallow: /*next=*%2Fprivate-${i}*%3Fx\n`;
    return text;
  };
  const latin1 = (count: number): { text: string; bytes: Uint8Array } => {
    let text = "user-agent: *\n";
    const bytes: number[] = [];
    for (const char of text) bytes.push(char.charCodeAt(0));
    for (let i = 0; i < count; i++) {
      const line = `disallow: /caf\u00e9-${i}/\n`;
      text += line;
      for (const char of line) bytes.push(char.charCodeAt(0));
    }
    return { text, bytes: Uint8Array.from(bytes) };
  };
  const withPaths = (base: Site, paths: string[]): Site => ({
    ...base,
    paths,
    escapedPaths: paths.map(escapePath),
    urls: paths.map((path) => `https://www.${base.name}${path}`),
  });

  const encoded = latin1(1_000);
  return [
    site("synthetic-1k-prefixes", manyPrefixes(1_000), 200),
    site("synthetic-10k-prefixes", manyPrefixes(10_000), 200),
    site("synthetic-1k-wildcards", wildcards(1_000), 200),
    site("synthetic-2k-groups", manyGroups(2_000), 200),
    site("synthetic-latin1", encoded.text, 200, encoded.bytes),
    withPaths(
      site("synthetic-query-escapes", queryEscapes(1_000), 0),
      Array.from({ length: 50 }, (_, i) => `/login?next=/private-${i * 19}?x&a=b`),
    ),
    // Each rule scans the whole path, then fails on its last middle segment.
    withPaths(
      site("synthetic-wildcards-near-miss", wildcards(1_000), 0),
      Array.from({ length: 50 }, () => `/${"abcde-".repeat(667)}`),
    ),
    // Each rule reaches its unanchored final segment, then fails there.
    withPaths(
      site("synthetic-wildcards-final-segment", finalSegments(1_000), 0),
      Array.from({ length: 50 }, () => `/${"abcde-".repeat(667)}`),
    ),
    withPaths(
      site("synthetic-wildcards-early-exit", wildcards(1_000), 0),
      Array.from({ length: 50 }, () => `/${"a-".repeat(2_000)}`),
    ),
  ];
}
