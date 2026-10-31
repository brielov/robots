/**
 * Single-pass robots.txt scanner.
 *
 * Parsing deliberately does as little as possible: rule values are recorded as
 * offsets into the source rather than sliced, because a typical consumer only
 * ever compiles one group out of the file. Canonicalization and sorting happen
 * later, per agent.
 */

/** RFC 9309 section 2.5 requires a parsing limit of at least 500 KiB. */
export const DEFAULT_MAX_BYTES = 500 * 1024;

const TAB = 0x09;
const LF = 0x0a;
const VT = 0x0b;
const FF = 0x0c;
const CR = 0x0d;
const SPACE = 0x20;
const HASH = 0x23;
const NUL = 0x00;
const STAR = 0x2a;
const HYPHEN = 0x2d;
const COLON = 0x3a;
const UNDERSCORE = 0x5f;
const BOM = 0xfeff;

const DIRECTIVE_NONE = 0;
const DIRECTIVE_USER_AGENT = 1;
const DIRECTIVE_ALLOW = 2;
const DIRECTIVE_DISALLOW = 3;
const DIRECTIVE_SITEMAP = 4;
const DIRECTIVE_CRAWL_DELAY = 5;

/** The group key used by `User-agent: *`. */
export const GLOBAL_AGENT = "*";

export interface Group {
  /** First rule of this group, as an index into the rule list. */
  firstRule: number;
  /** One past the last rule of this group. */
  endRule: number;
  crawlDelay: number | undefined;
}

export interface ParsedFile {
  source: string;
  /**
   * Two entries per rule: start offset, then end offset. The end offset is
   * stored negated for `Allow` rules. It can't be zero because empty values are
   * never recorded.
   */
  spans: number[];
  groups: Group[];
  /** Lowercased product token to the indexes of every group naming it. */
  agents: Map<string, number[]>;
  sitemaps: string[];
}

export interface RawRule {
  allow: boolean;
  pattern: string;
}

export interface ParseOptions {
  /**
   * Bytes of input to consider, or UTF-16 code units when given a string.
   * Input beyond the limit is dropped at a line boundary, so a rule is never
   * cut in half. Defaults to 500 KiB. `Infinity` disables the limit; a negative
   * or `NaN` value throws a `RangeError`.
   */
  maxBytes?: number;
}

function isSpace(code: number): boolean {
  return code === SPACE || code === TAB || code === VT || code === FF;
}

function isNewline(code: number): boolean {
  return code === LF || code === CR;
}

function isSeparator(code: number): boolean {
  return code === SPACE || code === TAB;
}

function isTokenChar(code: number): boolean {
  const lower = code | 0x20;
  return (lower >= 0x61 && lower <= 0x7a) || code === HYPHEN || code === UNDERSCORE;
}

/** Compares `source[start...]` to an already-lowercase literal, ignoring case. */
function keyEquals(source: string, start: number, literal: string): boolean {
  for (let i = 0; i < literal.length; i++) {
    if ((source.charCodeAt(start + i) | 0x20) !== literal.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

/**
 * Recognizes a directive name, including the misspellings Google's parser
 * accepts. RFC 9309 permits this leniency, and sites rely on it because their
 * files behave as they expect under Googlebot.
 */
function classifyKey(source: string, start: number, end: number): number {
  switch (end - start) {
    case 5:
      if (keyEquals(source, start, "allow")) return DIRECTIVE_ALLOW;
      break;
    case 7:
      if (keyEquals(source, start, "sitemap")) return DIRECTIVE_SITEMAP;
      if (keyEquals(source, start, "disalow")) return DIRECTIVE_DISALLOW;
      break;
    case 8:
      if (
        keyEquals(source, start, "disallow") ||
        keyEquals(source, start, "dissalow") ||
        keyEquals(source, start, "diasllow") ||
        keyEquals(source, start, "disallaw")
      ) {
        return DIRECTIVE_DISALLOW;
      }
      if (keyEquals(source, start, "site-map")) return DIRECTIVE_SITEMAP;
      break;
    case 9:
      if (keyEquals(source, start, "dissallow")) return DIRECTIVE_DISALLOW;
      if (keyEquals(source, start, "useragent")) return DIRECTIVE_USER_AGENT;
      break;
    case 10:
      if (keyEquals(source, start, "user-agent") || keyEquals(source, start, "user agent")) {
        return DIRECTIVE_USER_AGENT;
      }
      break;
    case 11:
      if (keyEquals(source, start, "crawl-delay")) return DIRECTIVE_CRAWL_DELAY;
      break;
  }
  return DIRECTIVE_NONE;
}

/**
 * Reduces a user-agent value to its product token: `*`, or the leading run of
 * `[a-zA-Z_-]`. A value such as "Foo Bar" therefore names "foo", which is more
 * restrictive than ignoring the line. Returns "" when there is no token.
 */
function readAgentToken(source: string, start: number, end: number): string {
  if (source.charCodeAt(start) === STAR) {
    const next = start + 1;
    return next === end || isSpace(source.charCodeAt(next)) ? GLOBAL_AGENT : "";
  }
  let tokenEnd = start;
  while (tokenEnd < end && isTokenChar(source.charCodeAt(tokenEnd))) tokenEnd++;
  return source.slice(start, tokenEnd).toLowerCase();
}

/** Plain decimals only: `Number` alone would also accept "0x10" and "1e3". */
const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

function readCrawlDelay(value: string): number | undefined {
  if (!DECIMAL.test(value)) return undefined;
  const delay = Number(value);
  return Number.isFinite(delay) ? delay : undefined;
}

function scan(source: string, start: number, limit: number): ParsedFile {
  const spans: number[] = [];
  const groups: Group[] = [];
  const agents = new Map<string, number[]>();
  const sitemaps: string[] = [];

  let group: Group | undefined;
  // A user-agent line after a rule opens a new group; before one, it extends
  // the current group. Other records must not affect this (RFC 9309 2.2.4).
  let seenRule = false;
  let pos = start;

  while (pos < limit) {
    let colon = -1;
    let contentEnd = pos;
    let code = 0;
    for (; contentEnd < limit; contentEnd++) {
      code = source.charCodeAt(contentEnd);
      if (code === HASH || code === NUL || isNewline(code)) break;
      if (code === COLON && colon < 0) colon = contentEnd;
    }

    let next = contentEnd;
    // Like Google's C string handling, NUL ends the line's content.
    if (code === HASH || code === NUL) {
      while (next < limit && !isNewline(source.charCodeAt(next))) next++;
    }
    next++;

    let lineStart = pos;
    pos = next;

    while (lineStart < contentEnd && isSpace(source.charCodeAt(lineStart))) lineStart++;
    while (contentEnd > lineStart && isSpace(source.charCodeAt(contentEnd - 1))) contentEnd--;

    let keyEnd: number;
    let valueStart: number;
    if (colon >= 0) {
      keyEnd = colon;
      valueStart = colon + 1;
    } else {
      // Google accepts whitespace in place of a forgotten colon, but only when
      // the line is exactly two tokens.
      keyEnd = lineStart;
      while (keyEnd < contentEnd && !isSeparator(source.charCodeAt(keyEnd))) keyEnd++;
      if (keyEnd === contentEnd) continue;
      valueStart = keyEnd;
    }
    if (colon < 0) {
      while (valueStart < contentEnd && isSeparator(source.charCodeAt(valueStart))) valueStart++;
      let inner = valueStart;
      while (inner < contentEnd && !isSeparator(source.charCodeAt(inner))) inner++;
      if (inner !== contentEnd) continue;
    }
    while (valueStart < contentEnd && isSpace(source.charCodeAt(valueStart))) valueStart++;
    while (keyEnd > lineStart && isSpace(source.charCodeAt(keyEnd - 1))) keyEnd--;

    switch (classifyKey(source, lineStart, keyEnd)) {
      case DIRECTIVE_USER_AGENT: {
        if (group === undefined || seenRule) {
          const firstRule = spans.length >> 1;
          group = { firstRule, endRule: firstRule, crawlDelay: undefined };
          groups.push(group);
          seenRule = false;
        }
        const token = readAgentToken(source, valueStart, contentEnd);
        if (token === "") break;
        const id = groups.length - 1;
        const ids = agents.get(token);
        if (ids === undefined) agents.set(token, [id]);
        else if (ids[ids.length - 1] !== id) ids.push(id);
        break;
      }
      case DIRECTIVE_ALLOW:
      case DIRECTIVE_DISALLOW: {
        // Rules outside any group are ignored (RFC 9309 2.2.2).
        if (group === undefined) break;
        seenRule = true;
        // An empty value matches nothing, but still ends the user-agent run.
        if (valueStart === contentEnd) break;
        const allow =
          source.charCodeAt(lineStart) === 0x61 || source.charCodeAt(lineStart) === 0x41;
        spans.push(valueStart, allow ? -contentEnd : contentEnd);
        group.endRule = spans.length >> 1;
        break;
      }
      case DIRECTIVE_SITEMAP:
        if (valueStart !== contentEnd) sitemaps.push(source.slice(valueStart, contentEnd));
        break;
      case DIRECTIVE_CRAWL_DELAY: {
        if (group === undefined) break;
        const delay = readCrawlDelay(source.slice(valueStart, contentEnd));
        if (delay !== undefined && (group.crawlDelay === undefined || delay > group.crawlDelay)) {
          group.crawlDelay = delay;
        }
        break;
      }
    }
  }

  return { source, spans, groups, agents, sitemaps };
}

/** Finds where to stop reading a string so that no line is cut in half. */
function stringLimit(source: string, maxBytes: number): number {
  if (source.length <= maxBytes) return source.length;
  if (isNewline(source.charCodeAt(maxBytes))) return maxBytes;
  for (let i = maxBytes; i > 0; i--) {
    if (isNewline(source.charCodeAt(i - 1))) return i;
  }
  return 0;
}

function byteLimit(bytes: Uint8Array, maxBytes: number): number {
  if (bytes.length <= maxBytes) return bytes.length;
  if (isNewline(bytes[maxBytes] as number)) return maxBytes;
  for (let i = maxBytes; i > 0; i--) {
    if (isNewline(bytes[i - 1] as number)) return i;
  }
  return 0;
}

/**
 * Keeps octets of a non-UTF-8 file rather than replacing them with U+FFFD:
 * percent-escaping them is the bridge RFC 9309 2.2.2 allows, so a Latin-1 rule
 * still matches the equally escaped URL.
 */
function escapeHighBytes(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number;
    if (byte < 0x80) out += String.fromCharCode(byte);
    else out += `%${byte.toString(16).toUpperCase()}`;
  }
  return out;
}

function decode(bytes: Uint8Array, maxBytes: number): string {
  // A partial BOM is skipped too, matching Google's parser.
  let start = 0;
  if (bytes[0] === 0xef) {
    start = 1;
    if (bytes[1] === 0xbb) {
      start = 2;
      if (bytes[2] === 0xbf) start = 3;
    }
  }
  const body = bytes.subarray(start, byteLimit(bytes, maxBytes));
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return escapeHighBytes(body);
  }
}

export function parseFile(input: string | Uint8Array, options?: ParseOptions): ParsedFile {
  const limit = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  // Reading nothing would mean allowing everything, so a bad limit must not
  // pass silently.
  if (!(limit >= 0)) throw new RangeError(`Invalid maxBytes: ${limit}`);
  const maxBytes = Math.floor(limit);
  if (typeof input === "string") {
    const start = input.charCodeAt(0) === BOM ? 1 : 0;
    return scan(input, start, stringLimit(input, maxBytes));
  }
  const source = decode(input, maxBytes);
  return scan(source, 0, source.length);
}

/** Lists the rules for a set of groups in file order, with their raw patterns. */
export function collectRules(file: ParsedFile, groupIds: readonly number[]): RawRule[] {
  const rules: RawRule[] = [];
  for (const id of groupIds) {
    const group = file.groups[id] as Group;
    for (let rule = group.firstRule; rule < group.endRule; rule++) {
      const start = file.spans[rule * 2] as number;
      const end = file.spans[rule * 2 + 1] as number;
      const allow = end < 0;
      rules.push({ allow, pattern: file.source.slice(start, allow ? -end : end) });
    }
  }
  return rules;
}
