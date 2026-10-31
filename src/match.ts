/**
 * Compiles the rules of one user agent into a flat, sorted list.
 *
 * Rules are ordered so that the first one to match is the one RFC 9309 says
 * must win: longest pattern first, `Allow` first on a tie. Matching can then
 * stop at the first hit.
 *
 * Patterns are matched without regular expressions. They are untrusted input,
 * and since `*` is the only metacharacter, taking the earliest end for each
 * literal segment is always correct and never needs to backtrack.
 */

import { canonicalPattern, decodeQueryDelimiters } from "./canonical.ts";
import type { RawRule } from "./parse.ts";

const KIND_PREFIX = 0;
const KIND_EXACT = 1;
const KIND_WILDCARD = 2;

const STAR = "*";
const DOLLAR = "$";
const ROBOTS_PATH = "/robots.txt";

interface SortableRule {
  allow: boolean;
  canonical: string;
}

export interface CompiledRules {
  count: number;
  kinds: Uint8Array;
  allows: Uint8Array;
  /** The literal for prefix and exact rules; "" for wildcard rules. */
  literals: string[];
  /** The `*`-separated segments of each rule; only wildcard rules use them. */
  segments: string[][];
  /**
   * How each segment reads inside a query, for the rare wildcard rule where
   * that differs. Holds `NO_SEGMENTS` for every other rule.
   */
  querySegments: string[][];
  /** Whether a wildcard rule must reach the end of the path. */
  anchored: Uint8Array;
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

export function compileRules(rawRules: readonly RawRule[]): CompiledRules {
  const rules = prepareRules(rawRules);
  const count = rules.length;
  const kinds = new Uint8Array(count);
  const allows = new Uint8Array(count);
  const anchored = new Uint8Array(count);
  const literals: string[] = [];
  const segments: string[][] = [];
  const querySegments: string[][] = [];

  for (let i = 0; i < count; i++) {
    const rule = rules[i] as SortableRule;
    allows[i] = rule.allow ? 1 : 0;

    // A pattern's priority is fixed by the sort above, so the simplifications
    // below can't change which rule wins.
    let pattern = rule.canonical.replace(/\*{2,}/g, STAR);
    let isAnchored = pattern.endsWith(DOLLAR);
    if (isAnchored) pattern = pattern.slice(0, -1);
    // A trailing `*` accepts whatever is left, with or without an anchor.
    if (pattern.endsWith(STAR)) {
      pattern = pattern.slice(0, -1);
      isAnchored = false;
    }

    if (pattern.includes(STAR)) {
      kinds[i] = KIND_WILDCARD;
      anchored[i] = isAnchored ? 1 : 0;
      literals.push("");
      const parts = pattern.split(STAR);
      const decoded = parts.map(decodeQueryDelimiters);
      segments.push(parts);
      querySegments.push(
        decoded.some((part, index) => part !== parts[index]) ? decoded : NO_SEGMENTS,
      );
    } else {
      kinds[i] = isAnchored ? KIND_EXACT : KIND_PREFIX;
      literals.push(pattern);
      segments.push(NO_SEGMENTS);
      querySegments.push(NO_SEGMENTS);
    }
  }

  return { count, kinds, allows, literals, segments, querySegments, anchored };
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

/** Decides a canonical path. */
export function isPathAllowed(rules: CompiledRules, path: string): boolean {
  const { count, kinds, allows, literals, segments, querySegments, anchored } = rules;
  for (let i = 0; i < count; i++) {
    let matched: boolean;
    switch (kinds[i]) {
      case KIND_PREFIX:
        matched = path.startsWith(literals[i] as string);
        break;
      case KIND_EXACT:
        matched = path === literals[i];
        break;
      default: {
        const decoded = querySegments[i] as string[];
        matched =
          decoded === NO_SEGMENTS
            ? matchesWildcard(path, segments[i] as string[], anchored[i] === 1)
            : matchesWildcardInQuery(path, segments[i] as string[], decoded, anchored[i] === 1);
      }
    }
    if (matched) return allows[i] === 1 || path === ROBOTS_PATH;
  }
  return true;
}
