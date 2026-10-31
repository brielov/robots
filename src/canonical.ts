/**
 * Puts rule patterns and request paths into one canonical form, so that
 * matching can be a plain comparison of strings:
 *
 * - non-ASCII characters and octets unsafe in a URI are percent-encoded;
 * - escape sequences use uppercase hex;
 * - escaped unreserved characters are decoded (RFC 9309 figure 4);
 * - other reserved characters keep their exact form, so in a path `%2F` differs
 *   from `/`.
 *
 * There are three exceptions to that last rule:
 *
 * - `*` and `$` are always escaped in a request, because RFC 9309 figure 6 has
 *   the pattern `%2A` match a literal `*` in a URI. That leaves a bare `*` or
 *   `$` in a canonical pattern free to mean only a wildcard or an end anchor.
 * - `'` is always escaped, because the URL parser does that in queries, so a
 *   client asked for `?q='` really sends `?q=%27`.
 * - In a query, the RFC 3986 gen-delims `:`, `/`, `?`, `@`, `[` and `]` delimit
 *   nothing and clients send them in either form, so they match either way, as
 *   figure 4 shows for `:` and `/`. They are decoded rather than encoded so that
 *   a rule like `/a*\/b` still sees the `/` in `/a?x=%2Fb`. Sub-delims such as
 *   `,` and `;` can carry meaning for the application, so they stay distinct.
 */

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const DOLLAR = 0x24;
const PERCENT = 0x25;
const STAR = 0x2a;
const DOT = 0x2e;
const SLASH = 0x2f;
const QUESTION = 0x3f;
const BACKSLASH = 0x5c;

const HEX = "0123456789ABCDEF";

const KEEP_STAR = 1;
const KEEP_FINAL_DOLLAR = 2;
const IN_QUERY = 4;

/**
 * Sorts ASCII characters for scanning. `CHAR_SPECIAL` marks those that can't be
 * copied as they are: control characters, space, `#`, `%`, the characters neither
 * reserved nor unreserved by RFC 3986, and the `$`, `*` and `'` exceptions above.
 * The other two classes matter only to the scan in `canonicalPath`.
 */
const CHAR_SPECIAL = 1;
const CHAR_DOT = 2;
const CHAR_QUESTION = 3;
const CHARS = /* @__PURE__ */ buildCharTable();

function buildCharTable(): Uint8Array {
  const table = new Uint8Array(128);
  table.fill(CHAR_SPECIAL, 0, 0x21);
  table[0x7f] = CHAR_SPECIAL;
  for (const char of "\"#$%'*<>\\^`{|}") table[char.charCodeAt(0)] = CHAR_SPECIAL;
  table[DOT] = CHAR_DOT;
  table[QUESTION] = CHAR_QUESTION;
  return table;
}

function isUnreserved(code: number): boolean {
  const lower = code | 0x20;
  return (
    (lower >= 0x61 && lower <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2d ||
    code === DOT ||
    code === 0x5f ||
    code === 0x7e
  );
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  const lower = code | 0x20;
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x57 : -1;
}

function escapeOctet(octet: number): string {
  return `%${HEX.charAt(octet >> 4)}${HEX.charAt(octet & 0xf)}`;
}

function escapeCodePoint(codePoint: number): string {
  if (codePoint < 0x80) return escapeOctet(codePoint);
  if (codePoint < 0x800) {
    return escapeOctet(0xc0 | (codePoint >> 6)) + escapeOctet(0x80 | (codePoint & 0x3f));
  }
  if (codePoint < 0x10000) {
    return (
      escapeOctet(0xe0 | (codePoint >> 12)) +
      escapeOctet(0x80 | ((codePoint >> 6) & 0x3f)) +
      escapeOctet(0x80 | (codePoint & 0x3f))
    );
  }
  return (
    escapeOctet(0xf0 | (codePoint >> 18)) +
    escapeOctet(0x80 | ((codePoint >> 12) & 0x3f)) +
    escapeOctet(0x80 | ((codePoint >> 6) & 0x3f)) +
    escapeOctet(0x80 | (codePoint & 0x3f))
  );
}

function isQueryDelimiter(octet: number): boolean {
  return (
    octet === 0x3a ||
    octet === SLASH ||
    octet === QUESTION ||
    octet === 0x40 ||
    octet === 0x5b ||
    octet === 0x5d
  );
}

function encode(text: string, flags: number): string {
  const length = text.length;
  let out = "";
  let runStart = 0;

  for (let i = 0; i < length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80 && CHARS[code] !== CHAR_SPECIAL) continue;
    if (code === STAR && (flags & KEEP_STAR) !== 0) continue;
    if (code === DOLLAR && i === length - 1 && (flags & KEEP_FINAL_DOLLAR) !== 0) continue;

    out += text.slice(runStart, i);

    if (code === PERCENT) {
      const high = hexValue(text.charCodeAt(i + 1));
      const low = hexValue(text.charCodeAt(i + 2));
      if (high >= 0 && low >= 0) {
        const octet = (high << 4) | low;
        const decode = isUnreserved(octet) || ((flags & IN_QUERY) !== 0 && isQueryDelimiter(octet));
        out += decode ? String.fromCharCode(octet) : escapeOctet(octet);
        i += 2;
      } else {
        // A stray percent sign is not an escape. Browsers keep it, so do we.
        out += "%";
      }
    } else {
      // codePointAt pairs surrogates; a lone one has no UTF-8 form, so it
      // becomes U+FFFD, as TextEncoder and the URL parser do.
      const codePoint = text.codePointAt(i) as number;
      if (codePoint > 0xffff) i++;
      const isLoneSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
      out += escapeCodePoint(isLoneSurrogate ? 0xfffd : codePoint);
    }
    runStart = i + 1;
  }

  return runStart === 0 ? text : out + text.slice(runStart);
}

/** Canonicalizes a rule's pattern. */
export function canonicalPattern(pattern: string): string {
  const queryStart = pattern.indexOf("?");
  if (queryStart < 0) return encode(pattern, KEEP_STAR | KEEP_FINAL_DOLLAR);
  return (
    encode(pattern.slice(0, queryStart), KEEP_STAR) +
    encode(pattern.slice(queryStart), KEEP_STAR | KEEP_FINAL_DOLLAR | IN_QUERY)
  );
}

const ESCAPED_QUERY_DELIMITER = /%(?:2F|3A|3F|40|5B|5D)/g;

function decodeEscape(escape: string): string {
  return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
}

/**
 * Gives the form a piece of a pattern takes if it lands in a query. Text after
 * a `*` can land in the path or the query of a request, and an escaped delimiter
 * reads differently in each: `/a*%2Fb` must match `/a/%2Fb` as well as
 * `/a?x=/b`, which is how `/a?x=%2Fb` canonicalizes.
 */
export function decodeQueryDelimiters(text: string): string {
  return text.replace(ESCAPED_QUERY_DELIMITER, decodeEscape);
}

/** Resolves `.` and `..` segments, as a client does before sending a request. */
function removeDotSegments(path: string): string {
  if (!path.includes("/.")) return path;

  const segments = path.split("/");
  const output: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i] as string;
    const isLast = i === segments.length - 1;
    if (segment === "..") {
      output.pop();
      if (isLast) output.push("");
    } else if (segment === ".") {
      if (isLast) output.push("");
    } else {
      output.push(segment);
    }
  }
  return `/${output.join("/")}`;
}

/** Removes what the URL parser removes before looking at the path at all. */
export function stripIgnored(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= SPACE) start++;
  while (end > start && text.charCodeAt(end - 1) <= SPACE) end--;

  let out = "";
  let runStart = start;
  for (let i = start; i < end; i++) {
    const code = text.charCodeAt(i);
    if (code === TAB || code === LF || code === CR) {
      out += text.slice(runStart, i);
      runStart = i + 1;
    }
  }
  return runStart === 0 && end === text.length ? text : out + text.slice(runStart, end);
}

function canonicalizeSlowly(input: string): string {
  let text = stripIgnored(input);

  const fragment = text.indexOf("#");
  if (fragment >= 0) text = text.slice(0, fragment);

  const queryStart = text.indexOf("?");
  let path = queryStart >= 0 ? text.slice(0, queryStart) : text;
  const query = queryStart >= 0 ? text.slice(queryStart) : "";

  if (path.charCodeAt(0) !== SLASH && path.charCodeAt(0) !== BACKSLASH) path = `/${path}`;
  path = removeDotSegments(encode(path.replaceAll("\\", "/"), 0));
  return path + encode(query, IN_QUERY);
}

/**
 * Canonicalizes a request path with an optional query. The input is returned
 * as it is when a scan shows it is already canonical.
 */
export function canonicalPath(path: string): string {
  if (path.length === 0) return "/";
  return path.charCodeAt(0) === SLASH && isCanonicalFrom(path, 1) ? path : canonicalizeSlowly(path);
}

/** Scans text that starts a path at `start - 1` for anything to canonicalize. */
export function isCanonicalFrom(text: string, start: number): boolean {
  const length = text.length;
  let inQuery = false;
  for (let i = start; i < length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x80) return false;
    const kind = CHARS[code];
    if (kind === 0) continue;
    if (kind === CHAR_SPECIAL) return false;
    if (kind === CHAR_QUESTION) inQuery = true;
    else if (!inQuery && text.charCodeAt(i - 1) === SLASH) return false;
  }
  return true;
}
