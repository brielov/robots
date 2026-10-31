/**
 * Finds the path and query of a URL without `new URL()`, which allocates a
 * whole object to answer a question that is usually one scan away.
 *
 * Ordinary `http(s)://host/...` URLs take the fast route. Anything unusual takes
 * a slower route that treats the string the way a URL parser would, because a
 * crawler's HTTP client will normalize these forms before sending the request.
 * Canonicalization runs exactly once, whichever route a URL takes: it isn't
 * idempotent on malformed escapes.
 */

import { canonicalPath, isCanonicalFrom, stripIgnored } from "./canonical.ts";

const SPACE = 0x20;
const HASH = 0x23;
const SLASH = 0x2f;
const QUESTION = 0x3f;
const BACKSLASH = 0x5c;

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
/** The URL parser accepts any run of slashes after these, or none at all. */
const SPECIAL_SCHEME = /^(?:https?|ftp|wss?):$/i;

function isSlash(code: number): boolean {
  return code === SLASH || code === BACKSLASH;
}

/** Returns everything from the end of the authority that begins at `start`. */
function afterAuthority(text: string, start: number): string {
  for (let i = start; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isSlash(code) || code === QUESTION || code === HASH) return text.slice(i);
  }
  return "";
}

function requestPathSlowly(url: string): string {
  const text = stripIgnored(url);

  if (isSlash(text.charCodeAt(0))) {
    return isSlash(text.charCodeAt(1)) ? afterAuthority(text, 2) : text;
  }

  const scheme = SCHEME.exec(text)?.[0];
  if (scheme === undefined) return afterAuthority(text, 0);

  let start = scheme.length;
  if (SPECIAL_SCHEME.test(scheme)) {
    while (isSlash(text.charCodeAt(start))) start++;
    return afterAuthority(text, start);
  }
  // Anything else with no `//` is more likely `localhost:8080/a` than a scheme.
  return text.startsWith("//", start) ? afterAuthority(text, start + 2) : afterAuthority(text, 0);
}

/** Finds where an ordinary URL's authority ends, or returns -1 for anything else. */
function endOfAuthority(url: string): number {
  let start: number;
  if (url.startsWith("https://")) start = 8;
  else if (url.startsWith("http://")) start = 7;
  else return -1;

  for (let i = start; i < url.length; i++) {
    const code = url.charCodeAt(i);
    if (code === SLASH || code === QUESTION || code === HASH) return i === start ? -1 : i;
    if (code === BACKSLASH || code <= SPACE) return -1;
  }
  return url.length;
}

/** Returns everything after the authority; `canonicalPath` drops any fragment. */
export function requestPath(url: string): string {
  const end = endOfAuthority(url);
  return end < 0 ? requestPathSlowly(url) : url.slice(end);
}

/**
 * Returns a URL's canonical path and query. Most URLs are canonical already, so
 * this scans the URL itself and takes a slice only at the end.
 */
export function canonicalRequestPath(url: string): string {
  const end = endOfAuthority(url);
  if (end >= 0 && url.charCodeAt(end) === SLASH && isCanonicalFrom(url, end + 1)) {
    return url.slice(end);
  }
  return canonicalPath(end < 0 ? requestPathSlowly(url) : url.slice(end));
}
