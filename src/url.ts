/**
 * Finds the path and query of a URL without `new URL()`, which allocates a
 * whole object to answer a question that is usually one scan away.
 *
 * Ordinary `http(s)://host/...` URLs take the fast route. Anything unusual takes
 * a slower route that treats the string the way a URL parser would, because a
 * crawler's HTTP client will normalize these forms before sending the request.
 * This only locates the path; `canonicalPath` then normalizes what it returns.
 */

import { stripIgnored } from "./canonical.ts";

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

/** Returns everything after the authority; `canonicalPath` drops any fragment. */
export function requestPath(url: string): string {
  let start: number;
  if (url.startsWith("https://")) start = 8;
  else if (url.startsWith("http://")) start = 7;
  else return requestPathSlowly(url);

  for (let i = start; i < url.length; i++) {
    const code = url.charCodeAt(i);
    if (code === SLASH || code === QUESTION || code === HASH) {
      return i === start ? requestPathSlowly(url) : url.slice(i);
    }
    if (code === BACKSLASH || code <= SPACE) return requestPathSlowly(url);
  }
  return "";
}
