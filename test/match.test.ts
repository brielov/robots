import { describe, expect, test } from "bun:test";
import { canonicalPath, canonicalPattern, decodeQueryDelimiters } from "../src/canonical.ts";
import { parse, robotsForStatus } from "../src/index.ts";
import { compileRules, isPathAllowed } from "../src/match.ts";

describe("canonicalPattern", () => {
  test.each([
    ["/plain/path?a=b", "/plain/path?a=b"],
    ["/a*b", "/a*b"],
    ["/a$", "/a$"],
    ["/a$b", "/a%24b"],
    ["/$$", "/%24$"],
    ["/%2a", "/%2A"],
    ["/%24", "/%24"],
    ["/%2f", "/%2F"],
    ["/%7E", "/~"],
    ["/%41%7a%30", "/Az0"],
    ["/%2D%2E%5F", "/-._"],
    ["/café", "/caf%C3%A9"],
    ["/ツ", "/%E3%83%84"],
    ["/\u{1F600}", "/%F0%9F%98%80"],
    ["/\uD800x", "/%EF%BF%BDx"],
    ["/x\uDC00", "/x%EF%BF%BD"],
    ["/a b", "/a%20b"],
    ['/"<>`{|}^', "/%22%3C%3E%60%7B%7C%7D%5E"],
    ["/a\\b", "/a%5Cb"],
    ["/\u007f\u0001", "/%7F%01"],
    ["/100%", "/100%"],
    ["/%zz", "/%zz"],
    ["/%4", "/%4"],
    ["/[x]:@!&()+,;=", "/[x]:@!&()+,;="],
    ["/a'b", "/a%27b"],
    ["/a%27b", "/a%27b"],
    ["/a?q='", "/a?q=%27"],
    ["/a%2Fb%3Ac%3Fd", "/a%2Fb%3Ac%3Fd"],
    ["/a?b%2Fc%3Ad%3Fe", "/a?b/c:d?e"],
    ["/a?b%2fc", "/a?b/c"],
    ["/a?b%26c%3Dd", "/a?b%26c%3Dd"],
    ["/a?b%2Fc?d", "/a?b/c?d"],
    ["/a%2Fb?c", "/a%2Fb?c"],
    ["/a?%40%5B%5D", "/a?@[]"],
    ["/a%40%5B%5D", "/a%40%5B%5D"],
    ["/a?%2C%3B%21%28%29", "/a?%2C%3B%21%28%29"],
    ["/a$?b", "/a%24?b"],
    ["/a?b$", "/a?b$"],
    ["/a?b$c$", "/a?b%24c$"],
    ["/*?a=*$", "/*?a=*$"],
    ["\u07ff", "%DF%BF"],
    ["\u0080", "%C2%80"],
    ["\u0800", "%E0%A0%80"],
    ["\uffff", "%EF%BF%BF"],
    ["\u{10000}", "%F0%90%80%80"],
    ["\u{10ffff}", "%F4%8F%BF%BF"],
  ])("%j becomes %j", (input, expected) => {
    expect(canonicalPattern(input)).toBe(expected);
  });
});

describe("decodeQueryDelimiters", () => {
  test("decodes gen-delims and leaves everything else", () => {
    expect(decodeQueryDelimiters("%2F%3A%3F%40%5B%5D")).toBe("/:?@[]");
    expect(decodeQueryDelimiters("a%2Cb%26c%252F")).toBe("a%2Cb%26c%252F");
  });

  test("returns text with no escapes unchanged", () => {
    expect(decodeQueryDelimiters("/plain")).toBe("/plain");
  });
});

describe("canonicalPath", () => {
  test.each([
    ["", "/"],
    ["/", "/"],
    ["/a/b?c=d", "/a/b?c=d"],
    ["a", "/a"],
    ["?q", "/?q"],
    ["#f", "/"],
    ["/a#b", "/a"],
    ["/a?b#c", "/a?b"],
    ["/a*b", "/a%2Ab"],
    ["/a$b", "/a%24b"],
    ["/a?b=*$", "/a?b=%2A%24"],
    ["/%2a", "/%2A"],
    ["/%2F", "/%2F"],
    ["/%7E", "/~"],
    ["/ツ", "/%E3%83%84"],
    ["/a b", "/a%20b"],
    ["/a\\b", "/a/b"],
    ["\\a", "/a"],
    ["/a?b\\c", "/a?b%5Cc"],
    ["/./a", "/a"],
    ["/a/.", "/a/"],
    ["/a/./b", "/a/b"],
    ["/a/..", "/"],
    ["/a/../b", "/b"],
    ["/a/b/../../c", "/c"],
    ["/a/b/..", "/a/"],
    ["/a/b/.", "/a/b/"],
    ["/a\r/b", "/a/b"],
    ["/a'b", "/a%27b"],
    ["/a?q='", "/a?q=%27"],
    ["/a?q=%27", "/a?q=%27"],
    ["/a%2Fb", "/a%2Fb"],
    ["/a?b=c%2Fd%3Ae%3Ff", "/a?b=c/d:e?f"],
    ["/a?b=c/d:e?f", "/a?b=c/d:e?f"],
    ["/a?b%26c", "/a?b%26c"],
    ["/a?%40%5B%5D", "/a?@[]"],
    ["/a?%2C%3B", "/a?%2C%3B"],
    ["/../a", "/a"],
    ["/..", "/"],
    ["/.", "/"],
    ["//a/../b", "//b"],
    ["/%2e/a", "/a"],
    ["/a/%2E%2e/b", "/b"],
    ["/a/.%2e", "/"],
    ["/a/..b/.c", "/a/..b/.c"],
    ["/...", "/..."],
    ["/a?x=/../b", "/a?x=/../b"],
    ["/a\t/b\n/c\r", "/a/b/c"],
    ["  /a  ", "/a"],
    ["\u0001/a\u0002", "/a"],
  ])("%j becomes %j", (input, expected) => {
    expect(canonicalPath(input)).toBe(expected);
  });

  test("returns a canonical input without rebuilding it", () => {
    const path = "/already/canonical?x=1";
    expect(canonicalPath(path)).toBe(path);
  });
});

describe("compiled rules", () => {
  const rules = (...patterns: string[]) => patterns.map((pattern) => ({ allow: false, pattern }));

  test("sorts longest first, with allow first on a tie", () => {
    const compiled = compileRules([
      { allow: false, pattern: "/a" },
      { allow: false, pattern: "/longer" },
      { allow: false, pattern: "/b" },
      { allow: true, pattern: "/c" },
    ]);
    expect(compiled.literals[0]).toBe("/longer");
    expect(compiled.literals[1]).toBe("/c");
    expect(compiled.allows[1]).toBe(1);
  });

  test("drops duplicates", () => {
    expect(compileRules(rules("/a", "/a", "/%61")).count).toBe(1);
  });

  test("an allow makes the identical disallow unreachable", () => {
    const compiled = compileRules([
      { allow: false, pattern: "/a" },
      { allow: true, pattern: "/a" },
    ]);
    expect(compiled.count).toBe(1);
    expect(compiled.allows[0]).toBe(1);
  });

  test("classifies rules", () => {
    const compiled = compileRules(rules("/prefix", "/exact$", "/wild*card"));
    expect(compiled.kinds[compiled.literals.indexOf("/prefix")]).toBe(0);
    expect(compiled.kinds[compiled.literals.indexOf("/exact")]).toBe(1);
    expect(compiled.segments.filter((segments) => segments.length > 0)).toEqual([
      ["/wild", "card"],
    ]);
  });

  test.each([
    ["/a*", "/a"],
    ["/a**", "/a"],
    ["/a*$", "/a"],
    ["/a***$", "/a"],
    ["/*", "/"],
    ["*", ""],
  ])("%j reduces to the prefix %j", (pattern, literal) => {
    const compiled = compileRules(rules(pattern));
    expect(compiled.kinds[0]).toBe(0);
    expect(compiled.literals[0]).toBe(literal);
  });

  test("simplifying a pattern keeps its priority", () => {
    // "/fish*" counts as six octets even though it compiles to "/fish".
    const compiled = compileRules([
      { allow: true, pattern: "/fish" },
      { allow: false, pattern: "/fish*" },
    ]);
    expect(isPathAllowed(compiled, "/fish")).toBe(false);
  });

  test("escaped text counts by its canonical length", () => {
    const compiled = compileRules([
      { allow: false, pattern: "/%61" },
      { allow: true, pattern: "/a" },
    ]);
    expect(isPathAllowed(compiled, "/a")).toBe(true);
  });
});

describe("wildcards", () => {
  const disallowed = (pattern: string, path: string): boolean =>
    !parse(`user-agent: *\ndisallow: ${pattern}\n`).agent("a").isAllowedPath(path);

  test.each([
    ["/a*b", "/ab", true],
    ["/a*b", "/a-b", true],
    ["/a*b", "/a", false],
    ["/a*b*c", "/a-b-c", true],
    ["/a*b*c", "/a-c-b", false],
    ["/a*a", "/a", false],
    ["/a*a", "/aa", true],
    ["/a*ab$", "/aab", true],
    ["/a*b$", "/ab-b", true],
    ["/a*b$", "/ab-", false],
    ["/a*a$", "/a", false],
    ["/*a*a*$", "/-a-a-", true],
    ["/*a$", "/a?b=a", true],
    ["*.gif$", "/x.gif", true],
    ["*", "/anything", true],
    ["$", "/", false],
    ["*$", "/", true],
    ["/$", "/", true],
    ["/$", "/a", false],
    ["/a*/b*/c$", "/a/b/b/c", true],
    ["/a$b", "/a$b", true],
    ["/a$b", "/a", false],
  ])("%j against %j gives %p", (pattern, path, expected) => {
    expect(disallowed(pattern, path)).toBe(expected);
  });

  test.each([
    // A later segment may not overlap the end of an earlier one.
    ["/aba*a$", "/aba", false],
    ["/ab*ba", "/aba", false],
    // Each segment must begin after the one before it, not at it.
    ["/a*a*a", "/aa", false],
    ["/a*a*a", "/aaa", true],
    ["/a*b*a", "/ab", false],
    ["/a*ab*b", "/aab", false],
    ["/a*ab*b", "/aabb", true],
    // A match may begin right where the previous segment ended.
    ["/a*b*c", "/abc", true],
    // The first segment is anchored to the start of the path.
    ["/a*b", "/x/a-b", false],
  ])("segment bounds: %j against %j gives %p", (pattern, path, expected) => {
    expect(disallowed(pattern, path)).toBe(expected);
  });

  test.each([
    ["/*%2F*/", "/%2F?/", true],
    ["/*%2F?$", "/%2F?", true],
    ["/*%2F*/$", "/?/", false],
    ["/*%3F$", "/?", false],
    ["/*%2F*/", "/?/", false],
    ["/*%2F*%2F*a", "/?/a", false],
    ["/*%2F*/", "/?//", true],
    ["/*%2F*%2F$", "/?//", true],
  ])("query spelling bounds: %j against %j gives %p", (pattern, path, expected) => {
    expect(disallowed(pattern, path)).toBe(expected);
  });

  test("a pattern without a leading slash can't match a path", () => {
    expect(disallowed("foo", "/foo")).toBe(false);
  });

  test("handles pathological patterns quickly", () => {
    const pattern = `/${"*a".repeat(5_000)}b`;
    const path = `/${"a".repeat(100_000)}`;
    const start = performance.now();
    expect(disallowed(pattern, path)).toBe(false);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});

describe("agents", () => {
  test("agent names ignore case", () => {
    const robots = parse("user-agent: FooBot\ndisallow: /\n");
    expect(robots.agent("FOOBOT").isAllowedPath("/x")).toBe(false);
  });

  test("agents are cached", () => {
    const robots = parse("user-agent: a\ndisallow: /\n");
    expect(robots.agent("a")).toBe(robots.agent("A"));
    expect(robots.agent("nope")).toBe(robots.agent("other"));
  });

  test("handles a name found on Object.prototype", () => {
    const robots = parse("user-agent: *\ndisallow: /\n");
    expect(robots.agent("constructor").isAllowedPath("/x")).toBe(false);
    expect(robots.agent("__proto__").isAllowedPath("/x")).toBe(false);
  });

  test("merges the groups of one agent", () => {
    const robots = parse(
      "user-agent: a\ndisallow: /x\nuser-agent: b\ndisallow: /y\nuser-agent: a\nallow: /x/y\n",
    );
    const agent = robots.agent("a");
    expect(agent.isAllowedPath("/x")).toBe(false);
    expect(agent.isAllowedPath("/x/y")).toBe(true);
    expect(agent.isAllowedPath("/y")).toBe(true);
  });

  test("agent isolation: one agent's rules don't leak into another's", () => {
    const robots = parse("user-agent: a\ndisallow: /a\nuser-agent: b\ndisallow: /b\n");
    expect(robots.agent("a").isAllowedPath("/b")).toBe(true);
    expect(robots.agent("b").isAllowedPath("/a")).toBe(true);
  });
});

describe("crawlDelay", () => {
  test("is undefined when absent", () => {
    expect(parse("user-agent: a\ndisallow: /\n").agent("a").crawlDelay).toBeUndefined();
  });

  test("uses the agent's own group", () => {
    const robots = parse(
      "user-agent: *\ncrawl-delay: 1\ndisallow: /x\nuser-agent: a\ncrawl-delay: 2\n",
    );
    expect(robots.agent("zzz").crawlDelay).toBe(1);
    expect(robots.agent("a").crawlDelay).toBe(2);
  });

  test("a specific group doesn't inherit from the * group", () => {
    const robots = parse(
      "user-agent: *\ncrawl-delay: 1\ndisallow: /\nuser-agent: a\ndisallow: /\n",
    );
    expect(robots.agent("a").crawlDelay).toBeUndefined();
  });

  test("takes the largest across merged groups", () => {
    const robots = parse(
      "user-agent: a\ncrawl-delay: 2\ndisallow: /x\nuser-agent: a\ncrawl-delay: 7\ndisallow: /y\nuser-agent: a\ncrawl-delay: 3\n",
    );
    expect(robots.agent("a").crawlDelay).toBe(7);
  });

  test("keeps a delay of zero", () => {
    expect(parse("user-agent: a\ncrawl-delay: 0\n").agent("a").crawlDelay).toBe(0);
  });
});

describe("public API", () => {
  test("exposes sitemaps", () => {
    expect(parse("sitemap: https://a.test/s.xml\n").sitemaps).toEqual(["https://a.test/s.xml"]);
  });

  test("accepts bytes", () => {
    const robots = parse(new TextEncoder().encode("user-agent: a\ndisallow: /ツ\n"));
    expect(robots.agent("a").isAllowedPath("/%E3%83%84")).toBe(false);
  });

  test("escapes in a non-UTF-8 file match the same octets in a URL", () => {
    const head = new TextEncoder().encode("user-agent: a\ndisallow: /caf");
    const robots = parse(Uint8Array.from([...head, 0xe9, 0x0a]));
    expect(robots.agent("a").isAllowedPath("/caf%E9")).toBe(false);
  });

  test("passes options through", () => {
    const robots = parse("user-agent: a\ndisallow: /\n", { maxBytes: 0 });
    expect(robots.agent("a").isAllowedPath("/x")).toBe(true);
    expect(() => parse("", { maxBytes: -1 })).toThrow(RangeError);
  });

  test("accepts a URL object", () => {
    const agent = parse("user-agent: a\ndisallow: /x?y\n").agent("a");
    expect(agent.isAllowed(new URL("https://a.test/x?y=1"))).toBe(false);
    expect(agent.isAllowed(new URL("https://a.test/x"))).toBe(true);
  });

  test("the fragment is not part of the match", () => {
    const agent = parse("user-agent: a\ndisallow: /x$\n").agent("a");
    expect(agent.isAllowed("https://a.test/x#frag")).toBe(false);
    expect(agent.isAllowedPath("/x#frag")).toBe(false);
  });

  test("dot segments can't get past a rule", () => {
    const agent = parse("user-agent: a\ndisallow: /private\n").agent("a");
    expect(agent.isAllowed("https://a.test/public/../private")).toBe(false);
    expect(agent.isAllowedPath("/public/../private")).toBe(false);
    expect(agent.isAllowedPath("/public/%2e%2e/private")).toBe(false);
  });
});

describe("robotsForStatus", () => {
  const isOpen = (status: number): boolean =>
    robotsForStatus(status).agent("a").isAllowedPath("/x");

  test.each([400, 401, 403, 404, 410, 451, 499])("%d allows everything", (status) => {
    expect(isOpen(status)).toBe(true);
  });

  test.each([429, 500, 502, 503, 599, 0, 300, 399, 600, Number.NaN])(
    "%d disallows everything",
    (status) => {
      expect(isOpen(status)).toBe(false);
    },
  );

  test("/robots.txt stays allowed", () => {
    expect(robotsForStatus(503).agent("a").isAllowedPath("/robots.txt")).toBe(true);
  });
});
