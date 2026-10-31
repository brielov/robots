import { describe, expect, test } from "bun:test";
import { canonicalPath } from "../src/canonical.ts";
import { parse } from "../src/index.ts";
import { canonicalRequestPath, requestPath } from "../src/url.ts";

/** Runs both routes, which must always agree. */
const pathOf = (url: string): string => {
  const path = canonicalPath(requestPath(url));
  if (canonicalRequestPath(url) !== path) {
    throw new Error(`The routes disagree on ${JSON.stringify(url)}`);
  }
  return path;
};

describe("Google's GetPathParamsQuery cases", () => {
  test.each([
    ["", "/"],
    ["http://www.example.com", "/"],
    ["http://www.example.com/", "/"],
    ["http://www.example.com/a", "/a"],
    ["http://www.example.com/a/", "/a/"],
    ["http://www.example.com/a/b?c=http://d.e/", "/a/b?c=http://d.e/"],
    ["http://www.example.com/a/b?c=d&e=f#fragment", "/a/b?c=d&e=f"],
    ["example.com", "/"],
    ["example.com/", "/"],
    ["example.com/a", "/a"],
    ["example.com/a/", "/a/"],
    ["example.com/a/b?c=d&e=f#fragment", "/a/b?c=d&e=f"],
    ["a", "/"],
    ["a/", "/"],
    ["/a", "/a"],
    ["a/b", "/b"],
    ["example.com?a", "/?a"],
    ["example.com/a;b#c", "/a;b"],
    ["//a/b/c", "/b/c"],
  ])("%j gives %j", (url, expected) => {
    expect(pathOf(url)).toBe(expected);
  });
});

describe("Google's system test", () => {
  const robots = "user-agent: FooBot\ndisallow: /\n";

  test("empty robots.txt allows everything", () => {
    expect(parse("").agent("FooBot").isAllowed("")).toBe(true);
  });

  test("an empty agent gets no rules", () => {
    expect(parse(robots).agent("").isAllowed("")).toBe(true);
  });

  test("an empty URL means the root path", () => {
    expect(parse(robots).agent("FooBot").isAllowed("")).toBe(false);
  });

  test("all empty allows everything", () => {
    expect(parse("").agent("").isAllowed("")).toBe(true);
  });
});

describe("fast route", () => {
  test.each([
    ["https://a.test/x", "/x"],
    ["http://a.test/x", "/x"],
    ["https://a.test", ""],
    ["https://a.test?q=1", "?q=1"],
    ["https://a.test#frag", "#frag"],
    ["https://a.test:8080/x", "/x"],
    ["https://user:pw@a.test/x", "/x"],
    ["https://[::1]:8080/x", "/x"],
  ])("%j locates %j", (url, expected) => {
    expect(requestPath(url)).toBe(expected);
  });
});

describe("unusual URLs", () => {
  test.each([
    ["HTTP://A.TEST/x", "/x"],
    ["HtTpS://a.test/x", "/x"],
    ["  https://a.test/x  ", "/x"],
    ["\thttps://a.test/x", "/x"],
    ["ht\ntp://a.test/x", "/x"],
    ["https://a.\ttest/x", "/x"],
    ["https:\\\\a.test\\x", "/x"],
    ["https:/a.test/x", "/x"],
    ["https:a.test/x", "/x"],
    ["https:///a.test/x", "/x"],
    ["https://\\a.test/x", "/x"],
    ["https://a.test\\x", "/x"],
    ["ftp://a.test/x", "/x"],
    ["ws://a.test/x", "/x"],
    ["wss:a.test/x", "/x"],
    ["foo://a.test/x", "/x"],
    ["localhost:8080/x", "/x"],
    ["example.com:80/x?y", "/x?y"],
    ["mailto:a@b.test", "/"],
    ["\\\\a.test\\x", "/x"],
    ["/\\a.test/x", "/x"],
    ["?a", "/?a"],
    ["#a", "/"],
    ["http://", "/"],
    ["https://", "/"],
    ["https://?a", "/?a"],
    ["https://#a", "/"],
    ["   ", "/"],
    ["http://\t/a/b", "/b"],
    ["HTTPS:/a.test/x", "/x"],
    ["ws:/a.test/x", "/x"],
    ["wss:/a.test/x", "/x"],
    ["ftp:/a.test/x", "/x"],
    ["s3://b/k", "/k"],
    ["localhost:/x", "/x"],
  ])("%j gives %j", (url, expected) => {
    expect(pathOf(url)).toBe(expected);
  });
});

describe("canonicalRequestPath", () => {
  test("returns a canonical path as it stands", () => {
    expect(canonicalRequestPath("https://a.test/b?c=d")).toBe("/b?c=d");
  });

  test.each([
    ["https://a.test", "/"],
    ["https://a.test?q", "/?q"],
    ["https://a.test#f", "/"],
    ["https://a.test/a/../b", "/b"],
    ["https://a.test/%62", "/b"],
    ["https://a.test/ツ", "/%E3%83%84"],
    ["https://a.test/a#f", "/a"],
    ["https://a.test/.", "/"],
    ["https://a.test/a b", "/a%20b"],
    ["https://a.test/a?b=/../c", "/a?b=/../c"],
    ["example.com/a", "/a"],
  ])("%j gives %j", (url, expected) => {
    expect(pathOf(url)).toBe(expected);
  });
});

describe("through the API", () => {
  test("keeps an empty query", () => {
    const agent = parse("user-agent: a\ndisallow: /x?\n").agent("a");
    expect(agent.isAllowed("http://a.test/x?")).toBe(false);
    expect(agent.isAllowedPath("/x?")).toBe(false);
    expect(agent.isAllowed(new URL("http://a.test/x?"))).toBe(false);
    expect(agent.isAllowed("http://a.test/x")).toBe(true);
  });

  test("an exact rule doesn't match an empty query", () => {
    const agent = parse("user-agent: a\ndisallow: /x$\n").agent("a");
    expect(agent.isAllowed("http://a.test/x?")).toBe(true);
    expect(agent.isAllowed(new URL("http://a.test/x?"))).toBe(true);
    expect(agent.isAllowed("http://a.test/x")).toBe(false);
  });

  test("a string and a URL object agree", () => {
    const agent = parse("user-agent: a\ndisallow: /p%20q\nallow: /p\ndisallow: /\n").agent("a");
    for (const url of [
      "http://a.test/p q",
      "http://a.test/p",
      "http://a.test/z",
      "http://a.test",
    ]) {
      expect(agent.isAllowed(url)).toBe(agent.isAllowed(new URL(url)));
    }
  });

  test("canonicalizes once: a stray percent can't turn into an escape", () => {
    // Canonicalizing twice would turn this into "/J" and match the rule.
    const agent = parse("user-agent: a\ndisallow: /J\n").agent("a");
    expect(agent.isAllowed("http://a.test/%4%41")).toBe(true);
    expect(agent.isAllowed(new URL("http://a.test/%4%41"))).toBe(true);
  });

  test("never throws on a string that isn't a URL", () => {
    const agent = parse("user-agent: a\ndisallow: /\n").agent("a");
    for (const url of ["http://", "::::", "\u0000", "http://[", "%", "\uD800"]) {
      expect(typeof agent.isAllowed(url)).toBe("boolean");
    }
  });

  test("a dot segment in a URL can't get past a rule", () => {
    const agent = parse("user-agent: a\ndisallow: /private\n").agent("a");
    expect(agent.isAllowed("https://a.test/public/../private")).toBe(false);
    expect(agent.isAllowed("https://a.test/public/%2e%2e/private")).toBe(false);
    expect(agent.isAllowed("https://a.test/public\\..\\private")).toBe(false);
  });
});

describe("parity with new URL()", () => {
  /** mulberry32, so a failure reproduces from its seed. */
  const createRandom = (seed: number): ((limit: number) => number) => {
    let state = seed;
    return (limit) => {
      state = (state + 0x6d2b79f5) | 0;
      let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
      return ((mixed ^ (mixed >>> 14)) >>> 0) % limit;
    };
  };

  const prefixes = [
    "http://a.test",
    "https://a.test",
    "HTTP://a.test",
    "https://a.test:8080",
    "https://u:p@a.test",
    "https:/a.test",
    "https:a.test",
    "https:\\\\a.test",
    "https:///a.test",
    " https://a.test",
    "ht\ttps://a.\ntest",
    "ftp://a.test",
    "https://[::1]:8080",
    "HTTPS:/a.test",
    "ws:a.test",
    "wss://a.test",
    "http://\t",
    "https://\u0001a.test",
  ];
  const pieces = [
    "/",
    "/",
    "/",
    "a",
    "b",
    ".",
    "..",
    "/./",
    "/../",
    "%2e",
    "%2E",
    "?",
    "#",
    "\\",
    " ",
    "\t",
    "\n",
    "é",
    "'",
    "*",
    "$",
    "%2F",
    "%41",
    "%",
    "&",
    "=",
    "ツ",
    '"',
    "<",
    "{",
    "|",
    ":",
    "@",
    ";",
    "\r",
    "\u0001",
  ];

  /** What a client sends: the URL parser's path and query, `?` included. */
  const parserPath = (url: string): string | undefined => {
    if (!URL.canParse(url)) return undefined;
    const { href } = new URL(url);
    const hash = href.indexOf("#");
    const withoutHash = hash < 0 ? href : href.slice(0, hash);
    return withoutHash.slice(withoutHash.indexOf("/", withoutHash.indexOf("//") + 2));
  };

  test.each([1, 2, 3, 4, 5, 6])("seed %d", (seed) => {
    const random = createRandom(seed);
    const agent = parse(
      "user-agent: *\nallow: /a/b\ndisallow: /a\ndisallow: /*?\ndisallow: /*.$\nallow: /b*é\ndisallow: /b\n",
    ).agent("x");
    let compared = 0;
    for (let i = 0; i < 40_000; i++) {
      let url = prefixes[random(prefixes.length)] as string;
      const length = random(9);
      for (let j = 0; j < length; j++) url += pieces[random(pieces.length)];

      const expected = parserPath(url);
      if (expected === undefined) continue;
      compared++;
      const decided = agent.isAllowedPath(expected);
      if (agent.isAllowed(url) !== decided || agent.isAllowed(new URL(url)) !== decided) {
        throw new Error(
          `${JSON.stringify(url)}: routes disagree with the decision for ${expected}`,
        );
      }
      if (pathOf(new URL(url).href) !== canonicalPath(expected)) {
        throw new Error(`${JSON.stringify(url)}: the href route differs`);
      }
      if (pathOf(url) !== canonicalPath(expected)) {
        throw new Error(
          `${JSON.stringify(url)}: got ${pathOf(url)}, parser gives ${canonicalPath(expected)}`,
        );
      }
    }
    expect(compared).toBeGreaterThan(20_000);
  });
});
