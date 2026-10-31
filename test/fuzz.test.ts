/**
 * Differential test against a deliberately naive matcher: a direct port of the
 * position-set algorithm in Google's robots.cc, which tries every rule and
 * shares no code or ideas with the implementation under test.
 */
import { describe, expect, test } from "bun:test";
import { canonicalPath, canonicalPattern } from "../src/canonical.ts";
import { parse } from "../src/index.ts";

function referenceMatches(path: string, pattern: string): boolean {
  let positions = [0];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "$" && i === pattern.length - 1) {
      return positions[positions.length - 1] === path.length;
    }
    if (char === "*") {
      const first = positions[0] as number;
      positions = [];
      for (let position = first; position <= path.length; position++) positions.push(position);
    } else {
      positions = positions
        .filter((position) => path[position] === char)
        .map((position) => position + 1);
      if (positions.length === 0) return false;
    }
  }
  return true;
}

/**
 * The position-set algorithm over canonical text, aware that an escaped
 * delimiter after a `*` also reads as its decoded form inside a query.
 */
function referenceMatchesCanonical(path: string, pattern: string): boolean {
  const queryStart = path.indexOf("?");
  let positions = new Set([0]);
  let seenStar = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === "$" && i === pattern.length - 1) return positions.has(path.length);
    if (char === "*") {
      seenStar = true;
      const first = Math.min(...positions);
      positions = new Set();
      for (let position = first; position <= path.length; position++) positions.add(position);
      continue;
    }
    const next = new Set<number>();
    const escape = pattern.slice(i, i + 3);
    const decoded = QUERY_ESCAPES[escape];
    if (seenStar && decoded !== undefined) {
      for (const position of positions) {
        if (path.startsWith(escape, position)) next.add(position + 3);
        if (queryStart >= 0 && position > queryStart && path[position] === decoded)
          next.add(position + 1);
      }
      i += 2;
    } else {
      for (const position of positions) if (path[position] === char) next.add(position + 1);
    }
    if (next.size === 0) return false;
    positions = next;
  }
  return true;
}

const QUERY_ESCAPES: Record<string, string> = {
  "%2F": "/",
  "%3A": ":",
  "%3F": "?",
  "%40": "@",
  "%5B": "[",
  "%5D": "]",
};

interface Rule {
  allow: boolean;
  pattern: string;
}

function referenceAllowed(
  rules: readonly Rule[],
  path: string,
  matches: (path: string, pattern: string) => boolean = referenceMatches,
): boolean {
  let allowPriority = -1;
  let disallowPriority = -1;
  for (const { allow, pattern } of rules) {
    // An empty pattern matches with priority zero, which never decides.
    if (pattern === "" || !matches(path, pattern)) continue;
    if (allow) allowPriority = Math.max(allowPriority, pattern.length);
    else disallowPriority = Math.max(disallowPriority, pattern.length);
  }
  return disallowPriority <= allowPriority;
}

/** mulberry32: deterministic, so a failure reproduces from its seed. */
function createRandom(seed: number): (limit: number) => number {
  let state = seed;
  return (limit) => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return (((mixed ^ (mixed >>> 14)) >>> 0) % limit) as number;
  };
}

function randomText(
  random: (limit: number) => number,
  alphabet: string,
  maxLength: number,
): string {
  let text = "";
  const length = random(maxLength + 1);
  for (let i = 0; i < length; i++) text += alphabet[random(alphabet.length)];
  return text;
}

function randomPattern(random: (limit: number) => number): string {
  const anchor = random(4) === 0 ? "$" : "";
  const start = random(8) === 0 ? "" : "/";
  return `${start}${randomText(random, "ab/?-**", 8)}${anchor}`;
}

function randomPath(random: (limit: number) => number): string {
  return `/${randomText(random, "ab/?-", 10)}`;
}

describe("differential fuzz against the reference matcher", () => {
  test.each([1, 2, 3, 4, 5, 6, 7, 8])("seed %d", (seed) => {
    const random = createRandom(seed);
    for (let file = 0; file < 2_000; file++) {
      const rules: Rule[] = [];
      const ruleCount = 1 + random(6);
      let text = "user-agent: *\n";
      for (let i = 0; i < ruleCount; i++) {
        const rule = { allow: random(2) === 0, pattern: randomPattern(random) };
        rules.push(rule);
        text += `${rule.allow ? "allow" : "disallow"}: ${rule.pattern}\n`;
      }
      const agent = parse(text).agent("x");
      for (let i = 0; i < 20; i++) {
        const path = randomPath(random);
        const actual = agent.isAllowedPath(path);
        if (actual !== referenceAllowed(rules, path)) {
          throw new Error(`seed ${seed}, path ${JSON.stringify(path)}, file:\n${text}`);
        }
      }
    }
    expect(true).toBe(true);
  });

  test("the generator covers both outcomes and every rule shape", () => {
    const random = createRandom(99);
    let allowed = 0;
    let denied = 0;
    let wildcard = 0;
    let anchored = 0;
    for (let i = 0; i < 5_000; i++) {
      const pattern = randomPattern(random);
      if (pattern.includes("*")) wildcard++;
      if (pattern.endsWith("$")) anchored++;
      const rules = [{ allow: false, pattern }];
      if (referenceAllowed(rules, randomPath(random))) allowed++;
      else denied++;
    }
    expect(Math.min(allowed, denied, wildcard, anchored)).toBeGreaterThan(200);
  });
});

describe("differential fuzz with many overlapping prefixes", () => {
  // Builds rule sets where literals nest and interleave, to exercise the sorted
  // prefix index, its ancestor links, and ranks competing across rule kinds.
  test.each([41, 42, 43, 44, 45])("seed %d", (seed) => {
    const random = createRandom(seed);
    for (let file = 0; file < 800; file++) {
      const rules: Rule[] = [];
      const ruleCount = 1 + random(60);
      let text = "user-agent: *\n";
      for (let i = 0; i < ruleCount; i++) {
        const shape = random(10);
        let pattern = `/${randomText(random, "ab/", 7)}`;
        if (shape === 0) pattern += "$";
        else if (shape === 1) pattern += "**";
        else if (shape === 2) pattern = `/*${randomText(random, "ab/", 4)}`;
        else if (shape === 3) pattern += `*${randomText(random, "ab", 2)}$`;
        const rule = { allow: random(2) === 0, pattern };
        rules.push(rule);
        text += `${rule.allow ? "allow" : "disallow"}: ${rule.pattern}\n`;
      }
      const agent = parse(text).agent("x");
      for (let i = 0; i < 25; i++) {
        const path = `/${randomText(random, "ab/", 9)}`;
        if (agent.isAllowedPath(path) !== referenceAllowed(rules, path)) {
          throw new Error(`seed ${seed}, path ${JSON.stringify(path)}, file:\n${text}`);
        }
      }
    }
    expect(true).toBe(true);
  });
});

describe("differential fuzz with canonicalization in play", () => {
  // The reference runs on canonical text, so this shares canonicalization with
  // the code under test and checks that the matcher and the canonical form
  // agree: `*`, `$`, escapes and priorities all have to line up.
  const pieces = [
    "a",
    "b",
    "/",
    "?",
    "?",
    "$",
    "%2A",
    "%24",
    "%41",
    "%2F",
    "%2F",
    "%3A",
    "%3F",
    "%",
    "é",
    "'",
  ];

  const randomPieces = (random: (limit: number) => number, maxLength: number): string => {
    let text = "";
    const length = random(maxLength + 1);
    for (let i = 0; i < length; i++) text += pieces[random(pieces.length)];
    return text;
  };

  test.each([11, 12, 13, 14])("seed %d", (seed) => {
    const random = createRandom(seed);
    for (let file = 0; file < 1_500; file++) {
      const rules: Rule[] = [];
      const ruleCount = 1 + random(5);
      let text = "user-agent: *\n";
      for (let i = 0; i < ruleCount; i++) {
        const star = () => (random(2) === 0 ? "*" : "");
        const raw = `/${randomPieces(random, 3)}${star()}${randomPieces(random, 3)}${star()}${randomPieces(random, 3)}${random(3) === 0 ? "$" : ""}`;
        const allow = random(2) === 0;
        rules.push({ allow, pattern: canonicalPattern(raw) });
        text += `${allow ? "allow" : "disallow"}: ${raw}\n`;
      }
      const agent = parse(text).agent("x");
      for (let i = 0; i < 15; i++) {
        const path = `/${randomPieces(random, 6)}`;
        const actual = agent.isAllowedPath(path);
        if (actual !== referenceAllowed(rules, canonicalPath(path), referenceMatchesCanonical)) {
          throw new Error(`seed ${seed}, path ${JSON.stringify(path)}, file:\n${text}`);
        }
      }
    }
    expect(true).toBe(true);
  });
});

describe("query delimiter forms", () => {
  const delimiters = [":", "/", "?", "@", "[", "]"];
  const escapes: Record<string, string> = {
    ":": "%3A",
    "/": "%2F",
    "?": "%3F",
    "@": "%40",
    "[": "%5B",
    "]": "%5D",
  };

  const randomQuery = (random: (limit: number) => number): string[] => {
    const tokens: string[] = [];
    const length = 1 + random(8);
    for (let i = 0; i < length; i++) {
      tokens.push(
        random(2) === 0 ? (delimiters[random(6)] as string) : ("ab=&"[random(4)] as string),
      );
    }
    return tokens;
  };

  // Writes each delimiter raw or escaped at random, so a rule and a URL for the
  // same query can disagree on every one of them.
  const spell = (tokens: readonly string[], random: (limit: number) => number): string =>
    tokens.map((token) => (random(2) === 0 ? (escapes[token] ?? token) : token)).join("");

  test.each([21, 22, 23])("any spelling of a query matches any other: seed %d", (seed) => {
    const random = createRandom(seed);
    for (let i = 0; i < 20_000; i++) {
      const tokens = randomQuery(random);
      const rule = `/p?${spell(tokens, random)}`;
      const path = `/p?${spell(tokens, random)}`;
      const robots = parse(`user-agent: *\ndisallow: ${rule}\n`);
      if (robots.agent("x").isAllowedPath(path)) {
        throw new Error(`rule ${rule} missed ${path}`);
      }
    }
    expect(true).toBe(true);
  });

  test.each([31, 32, 33])("a wildcard reaches any spelling in the query: seed %d", (seed) => {
    const random = createRandom(seed);
    for (let i = 0; i < 20_000; i++) {
      const tokens = randomQuery(random);
      const prefix = ["/p*", "/*x=*", "/p*x*"][random(3)] as string;
      const rule = `${prefix}${spell(tokens, random)}`;
      const path = `/p?x=${spell(tokens, random)}`;
      const robots = parse(`user-agent: *\ndisallow: ${rule}\n`);
      if (robots.agent("x").isAllowedPath(path)) {
        throw new Error(`rule ${rule} missed ${path}`);
      }
    }
    expect(true).toBe(true);
  });
});

describe("the reference matcher", () => {
  test("agrees with the patterns it was ported from", () => {
    expect(referenceMatches("/fish.php", "/fish*.php")).toBe(true);
    expect(referenceMatches("/a", "/a$")).toBe(true);
    expect(referenceMatches("/ab", "/a$")).toBe(false);
    expect(referenceMatches("/a$b", "/a$b")).toBe(true);
    expect(referenceMatches("/ab", "/*b")).toBe(true);
    expect(referenceMatches("/ab", "/*c")).toBe(false);
  });
});
