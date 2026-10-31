/**
 * Compiles the rules of one user agent for matching.
 *
 * Every rule gets a rank: its place in the order where the best rule comes
 * first, which is longest pattern first, `Allow` first on a tie, as RFC 9309
 * requires. A decision is then the lowest rank among the rules that match.
 *
 * Finding that doesn't mean trying every rule, which matters because most URLs
 * match nothing, the case where trying rules in rank order can't stop early:
 *
 * - Prefix rules are sorted by text. Any prefix of a path sorts at or before the
 *   path, and everything between them shares that prefix, so the prefixes of a
 *   path are all ancestors of its sorted predecessor. Each entry stores the best
 *   rank among itself and its ancestors, so one binary search answers for them.
 * - Exact rules are looked up by their text.
 * - Wildcard rules are tried in rank order, only until they rank below the best
 *   match so far.
 *
 * Patterns are matched without regular expressions. They are untrusted input,
 * and since `*` is the only metacharacter, taking the earliest end for each
 * literal segment is always correct and never needs to backtrack.
 */

import { canonicalPattern, decodeQueryDelimiters } from "./canonical.ts";
import type { RawRule } from "./parse.ts";

const STAR = "*";
const DOLLAR = "$";
const ROBOTS_PATH = "/robots.txt";

interface SortableRule {
  allow: boolean;
  canonical: string;
}

export interface CompiledRules {
  /** Rule count, which also serves as the rank of "no rule". */
  count: number;
  /** Whether each rank is an `Allow` rule. */
  allows: Uint8Array;
  /** Prefix rule literals, sorted. */
  prefixes: string[];
  prefixLengths: Int32Array;
  /** The nearest earlier entry that is a prefix of each entry, or -1. */
  parents: Int32Array;
  /** The best rank among each entry and its ancestors. */
  bestRanks: Int32Array;
  /** Exact rule literals, to their ranks. */
  exact: Map<string, number>;
  /** The rank of each wildcard rule, ascending. */
  wildcardRanks: Int32Array;
  /** The `*`-separated segments of each wildcard rule. */
  segments: string[][];
  /**
   * How each segment reads inside a query, for the rare rule where that differs.
   * Holds `NO_SEGMENTS` for every other rule.
   */
  querySegments: string[][];
  /** Whether a wildcard rule must reach the end of the path. */
  anchored: Uint8Array;
}

interface PrefixEntry {
  literal: string;
  rank: number;
}

const NO_SEGMENTS: string[] = [];

/** Sorts by length and drops any rule that an earlier rule makes unreachable. */
function prepareRules(rules: readonly RawRule[]): SortableRule[] {
  const sorted = rules
    .map((rule) => ({ allow: rule.allow, canonical: canonicalPattern(rule.pattern) }))
    .sort((a, b) => b.canonical.length - a.canonical.length || Number(b.allow) - Number(a.allow));

  const seen = new Set<string>();
  return sorted.filter((rule) => {
    if (seen.has(rule.canonical)) return false;
    seen.add(rule.canonical);
    return true;
  });
}

/** Lays out prefix entries for `bestPrefixRank`. */
function indexPrefixes(entries: PrefixEntry[], count: number) {
  entries.sort((a, b) => (a.literal < b.literal ? -1 : a.literal > b.literal ? 1 : 0));

  const size = entries.length;
  const prefixes: string[] = [];
  const prefixLengths = new Int32Array(size);
  const parents = new Int32Array(size);
  const bestRanks = new Int32Array(size);
  // The chain of entries that are prefixes of the current one.
  const chain: number[] = [];

  for (let i = 0; i < size; i++) {
    const { literal, rank } = entries[i] as PrefixEntry;
    while (chain.length > 0 && !literal.startsWith(prefixes[chain.at(-1) as number] as string)) {
      chain.pop();
    }
    const parent = chain.at(-1) ?? -1;
    prefixes.push(literal);
    prefixLengths[i] = literal.length;
    parents[i] = parent;
    bestRanks[i] = Math.min(rank, parent < 0 ? count : (bestRanks[parent] as number));
    chain.push(i);
  }

  return { prefixes, prefixLengths, parents, bestRanks };
}

export function compileRules(rawRules: readonly RawRule[]): CompiledRules {
  const rules = prepareRules(rawRules);
  const count = rules.length;
  const allows = new Uint8Array(count);
  const entries: PrefixEntry[] = [];
  const exact = new Map<string, number>();
  const wildcardRanks: number[] = [];
  const anchored: number[] = [];
  const segments: string[][] = [];
  const querySegments: string[][] = [];

  for (let rank = 0; rank < count; rank++) {
    const rule = rules[rank] as SortableRule;
    allows[rank] = rule.allow ? 1 : 0;

    // A pattern's rank is fixed by the sort above, so the simplifications below
    // can't change which rule wins.
    let pattern = rule.canonical.replace(/\*{2,}/g, STAR);
    let isAnchored = pattern.endsWith(DOLLAR);
    if (isAnchored) pattern = pattern.slice(0, -1);
    // A trailing `*` accepts whatever is left, with or without an anchor.
    if (pattern.endsWith(STAR)) {
      pattern = pattern.slice(0, -1);
      isAnchored = false;
    }

    if (pattern.includes(STAR)) {
      const parts = pattern.split(STAR);
      const decoded = parts.map(decodeQueryDelimiters);
      wildcardRanks.push(rank);
      anchored.push(isAnchored ? 1 : 0);
      segments.push(parts);
      querySegments.push(
        decoded.some((part, index) => part !== parts[index]) ? decoded : NO_SEGMENTS,
      );
    } else if (isAnchored) {
      exact.set(pattern, rank);
    } else {
      entries.push({ literal: pattern, rank });
    }
  }

  return {
    count,
    allows,
    ...indexPrefixes(entries, count),
    exact,
    wildcardRanks: Int32Array.from(wildcardRanks),
    segments,
    querySegments,
    anchored: Uint8Array.from(anchored),
  };
}

function matchesWildcard(path: string, segments: readonly string[], anchored: boolean): boolean {
  const first = segments[0] as string;
  if (!path.startsWith(first)) return false;

  const last = segments.length - 1;
  let position = first.length;
  for (let i = 1; i < last; i++) {
    const segment = segments[i] as string;
    const found = path.indexOf(segment, position);
    if (found < 0) return false;
    position = found + segment.length;
  }

  const final = segments[last] as string;
  if (anchored) return path.length - final.length >= position && path.endsWith(final);
  return path.indexOf(final, position) >= 0;
}

/** Finds where a segment's first occurrence ends, or -1. */
function endOfSegment(path: string, segment: string, from: number): number {
  const found = path.indexOf(segment, from);
  return found < 0 ? -1 : found + segment.length;
}

/**
 * Matches a wildcard rule that has segments spelled differently in a query.
 * The escaped spelling can only occur before the `?`, so where it exists it also
 * ends first, and the decoded spelling is only searched when it doesn't. That
 * keeps the single forward pass of the plain case. The decoded spelling has to
 * begin after the `?`: a decoded `%3F` must not match the delimiter itself.
 */
function matchesWildcardInQuery(
  path: string,
  segments: readonly string[],
  querySegments: readonly string[],
  anchored: boolean,
): boolean {
  const queryStart = path.indexOf("?");
  if (queryStart < 0) return matchesWildcard(path, segments, anchored);

  const first = segments[0] as string;
  if (!path.startsWith(first)) return false;

  const last = segments.length - 1;
  const inQuery = queryStart + 1;
  let position = first.length;
  for (let i = 1; i < last; i++) {
    const segment = segments[i] as string;
    const querySegment = querySegments[i] as string;
    let end = endOfSegment(path, segment, position);
    if (end < 0 && querySegment !== segment) {
      end = endOfSegment(path, querySegment, Math.max(position, inQuery));
    }
    if (end < 0) return false;
    position = end;
  }

  const final = segments[last] as string;
  const queryFinal = querySegments[last] as string;
  const queryPosition = Math.max(position, inQuery);
  if (anchored) {
    return (
      (path.length - final.length >= position && path.endsWith(final)) ||
      (path.length - queryFinal.length >= queryPosition && path.endsWith(queryFinal))
    );
  }
  return path.indexOf(final, position) >= 0 || path.indexOf(queryFinal, queryPosition) >= 0;
}

/** Returns the best rank among the prefix rules matching a path. */
function bestPrefixRank(rules: CompiledRules, path: string): number {
  const { prefixes, prefixLengths, parents, bestRanks } = rules;

  // Finds the last entry that sorts at or before the path.
  let low = 0;
  let high = prefixes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((prefixes[middle] as string) <= path) low = middle + 1;
    else high = middle;
  }
  let entry = low - 1;
  if (entry < 0) return rules.count;

  // An ancestor is a prefix of the path if it fits in what the two share.
  const predecessor = prefixes[entry] as string;
  const limit = Math.min(predecessor.length, path.length);
  let shared = 0;
  while (shared < limit && predecessor.charCodeAt(shared) === path.charCodeAt(shared)) shared++;

  while (entry >= 0 && (prefixLengths[entry] as number) > shared) entry = parents[entry] as number;
  return entry < 0 ? rules.count : (bestRanks[entry] as number);
}

/** Decides a canonical path. */
export function isPathAllowed(rules: CompiledRules, path: string): boolean {
  const { count, allows, exact, wildcardRanks, segments, querySegments, anchored } = rules;

  let best = bestPrefixRank(rules, path);

  if (exact.size > 0) {
    const rank = exact.get(path);
    if (rank !== undefined && rank < best) best = rank;
  }

  for (let i = 0; i < wildcardRanks.length; i++) {
    const rank = wildcardRanks[i] as number;
    if (rank >= best) break;
    const decoded = querySegments[i] as string[];
    const matched =
      decoded === NO_SEGMENTS
        ? matchesWildcard(path, segments[i] as string[], anchored[i] === 1)
        : matchesWildcardInQuery(path, segments[i] as string[], decoded, anchored[i] === 1);
    if (matched) {
      best = rank;
      break;
    }
  }

  return best === count || allows[best] === 1 || path === ROBOTS_PATH;
}
