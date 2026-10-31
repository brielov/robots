/**
 * Google's robotstxt test suite (robots_test.cc) and the examples from RFC 9309.
 * Where the two disagree this follows the RFC. Figure 4's query row and the
 * escapes under "canonicalization parity" go further than Google's parser, which
 * compares escapes literally; a side effect is that a query rule's priority uses
 * its decoded length. The "differences from Google's parser" block holds the
 * remaining cases and explains each one.
 */
import { describe, expect, test } from "bun:test";
import { parse } from "../src/index.ts";

const allowed = (robots: string, agent: string, url: string): boolean =>
  parse(robots).agent(agent).isAllowed(url);

describe("line syntax", () => {
  test("rules are colon-separated, and a missing colon is tolerated", () => {
    const url = "http://foo.bar/x/y";
    expect(allowed("user-agent: FooBot\ndisallow: /\n", "FooBot", url)).toBe(false);
    expect(allowed("foo: FooBot\nbar: /\n", "FooBot", url)).toBe(true);
    expect(allowed("user-agent FooBot\ndisallow /\n", "FooBot", url)).toBe(false);
  });

  test("groups", () => {
    const robots = `allow: /foo/bar/

user-agent: FooBot
disallow: /
allow: /x/
user-agent: BarBot
disallow: /
allow: /y/


allow: /w/
user-agent: BazBot

user-agent: FooBot
allow: /z/
disallow: /
`;
    expect(allowed(robots, "FooBot", "http://foo.bar/x/b")).toBe(true);
    expect(allowed(robots, "FooBot", "http://foo.bar/z/d")).toBe(true);
    expect(allowed(robots, "FooBot", "http://foo.bar/y/c")).toBe(false);
    expect(allowed(robots, "BarBot", "http://foo.bar/y/c")).toBe(true);
    expect(allowed(robots, "BarBot", "http://foo.bar/w/a")).toBe(true);
    expect(allowed(robots, "BarBot", "http://foo.bar/z/d")).toBe(false);
    expect(allowed(robots, "BazBot", "http://foo.bar/z/d")).toBe(true);

    expect(allowed(robots, "FooBot", "http://foo.bar/foo/bar/")).toBe(false);
    expect(allowed(robots, "BarBot", "http://foo.bar/foo/bar/")).toBe(false);
    expect(allowed(robots, "BazBot", "http://foo.bar/foo/bar/")).toBe(false);
  });

  test("groups are not closed by other records", () => {
    const url = "http://foo.bar/";
    const sitemap =
      "User-agent: BarBot\nSitemap: https://foo.bar/sitemap\nUser-agent: *\nDisallow: /\n";
    expect(allowed(sitemap, "FooBot", url)).toBe(false);
    expect(allowed(sitemap, "BarBot", url)).toBe(false);

    const unknown =
      "User-agent: FooBot\nInvalid-Unknown-Line: unknown\nUser-agent: *\nDisallow: /\n";
    expect(allowed(unknown, "FooBot", url)).toBe(false);
    expect(allowed(unknown, "BarBot", url)).toBe(false);
  });

  test("record names are case insensitive", () => {
    for (const robots of [
      "USER-AGENT: FooBot\nALLOW: /x/\nDISALLOW: /\n",
      "user-agent: FooBot\nallow: /x/\ndisallow: /\n",
      "uSeR-aGeNt: FooBot\nAlLoW: /x/\ndIsAlLoW: /\n",
    ]) {
      expect(allowed(robots, "FooBot", "http://foo.bar/x/y")).toBe(true);
      expect(allowed(robots, "FooBot", "http://foo.bar/a/b")).toBe(false);
    }
  });
});

describe("user agents", () => {
  test("values are case insensitive", () => {
    for (const value of ["FOO BAR", "foo bar", "FoO bAr"]) {
      const robots = `User-Agent: ${value}\nAllow: /x/\nDisallow: /\n`;
      for (const agent of ["Foo", "foo"]) {
        expect(allowed(robots, agent, "http://foo.bar/x/y")).toBe(true);
        expect(allowed(robots, agent, "http://foo.bar/a/b")).toBe(false);
      }
    }
  });

  test("a value counts up to its first space", () => {
    const robots = "User-Agent: *\nDisallow: /\nUser-Agent: Foo Bar\nAllow: /x/\nDisallow: /\n";
    expect(allowed(robots, "Foo", "http://foo.bar/x/y")).toBe(true);
    expect(allowed(robots, "Foo Bar", "http://foo.bar/x/y")).toBe(false);
  });

  test("the * group is the fallback", () => {
    const url = "http://foo.bar/x/y";
    const global = "user-agent: *\nallow: /\nuser-agent: FooBot\ndisallow: /\n";
    const specific =
      "user-agent: FooBot\nallow: /\nuser-agent: BarBot\ndisallow: /\nuser-agent: BazBot\ndisallow: /\n";
    expect(allowed("", "FooBot", url)).toBe(true);
    expect(allowed(global, "FooBot", url)).toBe(false);
    expect(allowed(global, "BarBot", url)).toBe(true);
    expect(allowed(specific, "QuxBot", url)).toBe(true);
  });

  test("an empty agent name gets no rules", () => {
    expect(allowed("user-agent: FooBot\ndisallow: /\n", "", "http://foo.bar/")).toBe(true);
  });

  test("a specific group replaces the * group entirely", () => {
    const robots = "User-agent: *\nDisallow: /x/\nUser-agent: FooBot\nDisallow: /y/\n";
    expect(allowed(robots, "FooBot", "http://foo.bar/x/page")).toBe(true);
    expect(allowed(robots, "FooBot", "http://foo.bar/y/page")).toBe(false);
  });

  test("a specific group with no rules still replaces the * group", () => {
    const robots = "User-agent: *\nDisallow: /\nUser-agent: FooBot\n";
    expect(allowed(robots, "FooBot", "http://foo.bar/x")).toBe(true);
    expect(allowed(robots, "BarBot", "http://foo.bar/x")).toBe(false);
  });
});

describe("path matching", () => {
  test("is case sensitive", () => {
    const url = "http://foo.bar/x/y";
    expect(allowed("user-agent: FooBot\ndisallow: /x/\n", "FooBot", url)).toBe(false);
    expect(allowed("user-agent: FooBot\ndisallow: /X/\n", "FooBot", url)).toBe(true);
  });

  test("the longest match wins, and allow wins a tie", () => {
    const url = "http://foo.bar/x/page.html";
    const group = (rules: string) => `user-agent: FooBot\n${rules}`;

    expect(allowed(group("disallow: /x/page.html\nallow: /x/\n"), "FooBot", url)).toBe(false);

    const allowLonger = group("allow: /x/page.html\ndisallow: /x/\n");
    expect(allowed(allowLonger, "FooBot", url)).toBe(true);
    expect(allowed(allowLonger, "FooBot", "http://foo.bar/x/")).toBe(false);

    expect(allowed(group("disallow: \nallow: \n"), "FooBot", url)).toBe(true);
    expect(allowed(group("disallow: /\nallow: /\n"), "FooBot", url)).toBe(true);

    const slash = group("disallow: /x\nallow: /x/\n");
    expect(allowed(slash, "FooBot", "http://foo.bar/x")).toBe(false);
    expect(allowed(slash, "FooBot", "http://foo.bar/x/")).toBe(true);

    expect(allowed(group("disallow: /x/page.html\nallow: /x/page.html\n"), "FooBot", url)).toBe(
      true,
    );

    const wildcard = group("allow: /page\ndisallow: /*.html\n");
    expect(allowed(wildcard, "FooBot", "http://foo.bar/page.html")).toBe(false);
    expect(allowed(wildcard, "FooBot", "http://foo.bar/page")).toBe(true);

    const prefix = group("allow: /x/page.\ndisallow: /*.html\n");
    expect(allowed(prefix, "FooBot", url)).toBe(true);
    expect(allowed(prefix, "FooBot", "http://foo.bar/x/y.html")).toBe(false);
  });

  test("a query is part of the match", () => {
    const robots =
      "User-agent: FooBot\nDisallow: /\nAllow: /foo/bar?qux=taz&baz=http://foo.bar?tar&par\n";
    const url = "http://foo.bar/foo/bar?qux=taz&baz=http://foo.bar?tar&par";
    expect(allowed(robots, "FooBot", url)).toBe(true);
  });

  test("non-ASCII patterns match their percent-encoded form", () => {
    const encoded = "http://foo.bar/foo/bar/%E3%83%84";
    expect(
      allowed("User-agent: FooBot\nDisallow: /\nAllow: /foo/bar/ツ\n", "FooBot", encoded),
    ).toBe(true);
    expect(
      allowed("User-agent: FooBot\nDisallow: /\nAllow: /foo/bar/%E3%83%84\n", "FooBot", encoded),
    ).toBe(true);
  });

  test("special characters", () => {
    const star = "User-agent: FooBot\nDisallow: /foo/bar/quz\nAllow: /foo/*/qux\n";
    expect(allowed(star, "FooBot", "http://foo.bar/foo/bar/quz")).toBe(false);
    expect(allowed(star, "FooBot", "http://foo.bar/foo/quz")).toBe(true);
    expect(allowed(star, "FooBot", "http://foo.bar/foo//quz")).toBe(true);
    expect(allowed(star, "FooBot", "http://foo.bar/foo/bax/quz")).toBe(true);

    const end = "User-agent: FooBot\nDisallow: /foo/bar$\nAllow: /foo/bar/qux\n";
    expect(allowed(end, "FooBot", "http://foo.bar/foo/bar")).toBe(false);
    expect(allowed(end, "FooBot", "http://foo.bar/foo/bar/qux")).toBe(true);
    expect(allowed(end, "FooBot", "http://foo.bar/foo/bar/")).toBe(true);
    expect(allowed(end, "FooBot", "http://foo.bar/foo/bar/baz")).toBe(true);

    const comment = "User-agent: FooBot\n# Disallow: /\nDisallow: /foo/quz#qux\nAllow: /\n";
    expect(allowed(comment, "FooBot", "http://foo.bar/foo/bar")).toBe(true);
    expect(allowed(comment, "FooBot", "http://foo.bar/foo/quz")).toBe(false);
  });
});

describe("Google's documentation examples", () => {
  const checks = (allow: string, allowedPaths: string[], disallowedPaths: string[]): void => {
    const robots = `user-agent: FooBot\ndisallow: /\nallow: ${allow}\n`;
    for (const path of allowedPaths)
      expect(allowed(robots, "FooBot", `http://foo.bar${path}`)).toBe(true);
    for (const path of ["/bar", ...disallowedPaths]) {
      expect(allowed(robots, "FooBot", `http://foo.bar${path}`)).toBe(false);
    }
  };

  const fish = [
    "/fish",
    "/fish.html",
    "/fish/salmon.html",
    "/fishheads",
    "/fishheads/yummy.html",
    "/fish.html?id=anything",
  ];

  test("/fish", () => checks("/fish", fish, ["/Fish.asp", "/catfish", "/?id=fish"]));
  test("/fish*", () => checks("/fish*", fish, ["/Fish.bar", "/catfish", "/?id=fish"]));

  test("/fish/", () =>
    checks(
      "/fish/",
      ["/fish/", "/fish/salmon", "/fish/?salmon", "/fish/salmon.html", "/fish/?id=anything"],
      ["/fish", "/fish.html", "/Fish/Salmon.html"],
    ));

  test("/*.php", () =>
    checks(
      "/*.php",
      [
        "/filename.php",
        "/folder/filename.php",
        "/folder/filename.php?parameters",
        "//folder/any.php.file.html",
        "/filename.php/",
        "/index?f=filename.php/",
      ],
      ["/php/", "/index?php", "/windows.PHP"],
    ));

  test("/*.php$", () =>
    checks(
      "/*.php$",
      ["/filename.php", "/folder/filename.php"],
      [
        "/filename.php?parameters",
        "/filename.php/",
        "/filename.php5",
        "/php/",
        "/filename?php",
        "/aaaphpaaa",
        "//windows.PHP",
      ],
    ));

  test("/fish*.php", () =>
    checks("/fish*.php", ["/fish.php", "/fishheads/catfish.php?parameters"], ["/Fish.PHP"]));

  test("order of precedence", () => {
    const group = (rules: string) => `user-agent: FooBot\n${rules}\n`;
    expect(allowed(group("allow: /p\ndisallow: /"), "FooBot", "http://example.com/page")).toBe(
      true,
    );
    expect(
      allowed(
        group("allow: /folder\ndisallow: /folder"),
        "FooBot",
        "http://example.com/folder/page",
      ),
    ).toBe(true);
    expect(
      allowed(group("allow: /page\ndisallow: /*.htm"), "FooBot", "http://example.com/page.htm"),
    ).toBe(false);
    const root = group("allow: /$\ndisallow: /");
    expect(allowed(root, "FooBot", "http://example.com/")).toBe(true);
    expect(allowed(root, "FooBot", "http://example.com/page.html")).toBe(false);
  });
});

describe("RFC 9309 examples", () => {
  test("figure 2: groups for the same agent merge", () => {
    const robots =
      "user-agent: ExampleBot\ndisallow: /foo\ndisallow: /bar\n\nuser-agent: ExampleBot\ndisallow: /baz\n";
    for (const path of ["/foo", "/bar", "/baz"]) {
      expect(allowed(robots, "ExampleBot", `http://a.test${path}`)).toBe(false);
    }
  });

  test("figure 3: a non-matching agent uses the * group", () => {
    const robots =
      "user-agent: *\ndisallow: /foo\ndisallow: /bar\n\nuser-agent: BazBot\ndisallow: /baz\n";
    expect(allowed(robots, "ExampleBot", "http://a.test/foo")).toBe(false);
    expect(allowed(robots, "ExampleBot", "http://a.test/bar")).toBe(false);
    expect(allowed(robots, "ExampleBot", "http://a.test/baz")).toBe(true);
  });

  test("figure 4: percent-encoded URIs", () => {
    const rule = (pattern: string) => `user-agent: a\ndisallow: ${pattern}\n`;
    expect(allowed(rule("/foo/bar?baz=quz"), "a", "http://a.test/foo/bar?baz=quz")).toBe(false);
    const raw = "/foo/bar?baz=https://foo.bar";
    const encoded = "/foo/bar?baz=https%3A%2F%2Ffoo.bar";
    expect(allowed(rule(raw), "a", `http://a.test${raw}`)).toBe(false);
    expect(allowed(rule(raw), "a", `http://a.test${encoded}`)).toBe(false);
    expect(allowed(rule(encoded), "a", `http://a.test${raw}`)).toBe(false);
    expect(allowed(rule(encoded), "a", `http://a.test${encoded}`)).toBe(false);
    expect(allowed(rule("/foo/bar/%E3%83%84"), "a", "http://a.test/foo/bar/%E3%83%84")).toBe(false);
    expect(allowed(rule("/foo/bar/%62%61%7A"), "a", "http://a.test/foo/bar/baz")).toBe(false);
    expect(allowed(rule("/foo/bar/baz"), "a", "http://a.test/foo/bar/%62%61%7A")).toBe(false);
  });

  test("figure 6: escaping special characters", () => {
    const rule = (pattern: string) => `user-agent: a\ndisallow: ${pattern}\n`;
    const star = rule("/path/file-with-a-%2A.html");
    expect(allowed(star, "a", "https://www.example.com/path/file-with-a-*.html")).toBe(false);
    expect(allowed(star, "a", "https://www.example.com/path/file-with-a-x.html")).toBe(true);
    const dollar = rule("/path/foo-%24");
    expect(allowed(dollar, "a", "https://www.example.com/path/foo-$")).toBe(false);
    expect(allowed(dollar, "a", "https://www.example.com/path/foo-x")).toBe(true);
  });

  test("section 5.1: simple example", () => {
    const robots = `User-Agent: *
Disallow: *.gif$
Disallow: /example/
Allow: /publications/

User-Agent: foobot
Disallow:/
Allow:/example/page.html
Allow:/example/allowed.gif

User-Agent: barbot
User-Agent: bazbot
Disallow: /example/page.html

User-Agent: quxbot

EOF
`;
    const url = (path: string) => `https://example.com${path}`;
    expect(allowed(robots, "other", url("/a.gif"))).toBe(false);
    expect(allowed(robots, "other", url("/example/x"))).toBe(false);
    expect(allowed(robots, "other", url("/publications/x"))).toBe(true);
    expect(allowed(robots, "other", url("/a.gif?x"))).toBe(true);

    expect(allowed(robots, "foobot", url("/example/page.html"))).toBe(true);
    expect(allowed(robots, "foobot", url("/example/allowed.gif"))).toBe(true);
    expect(allowed(robots, "foobot", url("/example/other"))).toBe(false);
    expect(allowed(robots, "foobot", url("/"))).toBe(false);

    for (const agent of ["barbot", "bazbot"]) {
      expect(allowed(robots, agent, url("/example/page.html"))).toBe(false);
      expect(allowed(robots, agent, url("/example/other"))).toBe(true);
    }

    expect(allowed(robots, "quxbot", url("/example/page.html"))).toBe(true);
  });

  test("section 5.2: longest match", () => {
    const robots =
      "User-Agent: foobot\nAllow: /example/page/\nDisallow: /example/page/disallowed.gif\n";
    expect(allowed(robots, "foobot", "http://a.test/example/page/disallowed.gif")).toBe(false);
    expect(allowed(robots, "foobot", "http://a.test/example/page/ok.gif")).toBe(true);
  });

  test("/robots.txt is implicitly allowed", () => {
    const robots = "user-agent: *\ndisallow: /\n";
    expect(allowed(robots, "a", "http://a.test/robots.txt")).toBe(true);
    expect(allowed(robots, "a", "http://a.test/robots.txt?x")).toBe(false);
    expect(allowed(robots, "a", "http://a.test/robots.txt/x")).toBe(false);
  });
});

describe("canonicalization parity", () => {
  const blocked = (pattern: string, url: string): boolean =>
    !allowed(`user-agent: a\ndisallow: ${pattern}\n`, "a", url);

  test("an apostrophe in a query matches what clients send", () => {
    for (const pattern of ["/a?q='", "/a?q=%27", "/*'"]) {
      expect(blocked(pattern, "http://h.test/a?q='")).toBe(true);
      expect(blocked(pattern, "http://h.test/a?q=%27")).toBe(true);
    }
  });

  test("an apostrophe in a path is one thing in either form", () => {
    expect(blocked("/a'b", "http://h.test/a%27b")).toBe(true);
    expect(blocked("/a%27b", "http://h.test/a'b")).toBe(true);
  });

  test("%2F stays distinct from / in a path", () => {
    expect(blocked("/a/b", "http://h.test/a%2Fb")).toBe(false);
    expect(blocked("/a%2Fb", "http://h.test/a/b")).toBe(false);
  });

  test("a wildcard rule still sees delimiters escaped in the query", () => {
    expect(blocked("/a*/b", "http://h.test/a?x=%2Fb")).toBe(true);
    expect(blocked("/a*://", "http://h.test/a?u=https%3A%2F%2Fb")).toBe(true);
  });

  test("query parameters separators stay significant", () => {
    expect(blocked("/a?b&c", "http://h.test/a?b%26c")).toBe(false);
    expect(blocked("/a?b=c", "http://h.test/a?b%3Dc")).toBe(false);
    expect(blocked("/a?b+c", "http://h.test/a?b%2Bc")).toBe(false);
  });

  test("gen-delims in a query match in either form", () => {
    expect(blocked("/s?e=a@b.c", "http://h.test/s?e=a%40b.c")).toBe(true);
    expect(blocked("/s?e=a%40b.c", "http://h.test/s?e=a@b.c")).toBe(true);
    expect(blocked("/s?x=[a]", "http://h.test/s?x=%5Ba%5D")).toBe(true);
  });

  test("sub-delims in a query stay distinct", () => {
    expect(blocked("/s?l=a,b", "http://h.test/s?l=a%2Cb")).toBe(false);
    expect(blocked("/s?x=a;b", "http://h.test/s?x=a%3Bb")).toBe(false);
  });

  test.each([
    ["/a*%2Fb", "/a?x=%2Fb"],
    ["/a*%2Fb", "/a?x=/b"],
    ["/*%2Fadmin", "/login?next=%2Fadmin"],
    ["/*%3Fq", "/x?y=%3Fq"],
    ["/*%3A8080", "/x?h=a%3A8080"],
    ["/a*%2Fb?c", "/a?x=%2Fb?c"],
  ])("an escape after a wildcard still reaches the query: %j, %j", (pattern, path) => {
    expect(blocked(pattern, `http://h.test${path}`)).toBe(true);
  });

  test("an escape after a wildcard still means an escape in the path", () => {
    expect(blocked("/a*%2Fb", "http://h.test/a/%2Fb")).toBe(true);
    expect(blocked("/a*%2Fb", "http://h.test/a/b")).toBe(false);
    expect(blocked("/a*%2Fb", "http://h.test/aX/b")).toBe(false);
  });

  test("the part of a rule before its query keeps %2F distinct", () => {
    expect(blocked("/a%2Fb?c", "http://h.test/a%2Fb?c")).toBe(true);
    expect(blocked("/a%2Fb?c", "http://h.test/a/b?c")).toBe(false);
  });

  test.each([
    ["/*next=*%2Fadmin", "/login?next=%2Fadmin"],
    ["/*next=*%2Fadmin", "/login?next=/admin"],
    ["/a*x*%2Fb", "/a?x=%2Fb"],
    ["/*=*%3A", "/b?=a%3A"],
    ["/a*%2Fb*%2Fc", "/a?x=%2Fb%2Fc"],
    ["/a*%2Fb*%2Fc", "/a%2Fb?x=%2Fc"],
    ["/a*%2Fb*%2Fc", "/a/%2Fb/%2Fc"],
    ["/a*%2Fb$", "/a?x=%2Fb"],
    ["/a*%2Fb$", "/a/%2Fb"],
  ])("escapes after several wildcards: %j, %j", (pattern, path) => {
    expect(blocked(pattern, `http://h.test${path}`)).toBe(true);
  });

  test.each([
    ["/a*%3F", "/a?"],
    ["/a*%3F", "/a"],
    ["/a*%2Fb", "/a%3Fx/b"],
    ["/a*%2Fb$", "/a?x=%2Fb/c"],
    ["/a*%2Fb*%2Fc", "/a?x=%2Fc%2Fb"],
  ])("a query spelling doesn't over-match: %j, %j", (pattern, path) => {
    expect(blocked(pattern, `http://h.test${path}`)).toBe(false);
  });

  test("a rule keeps its priority whichever spelling matches", () => {
    // The rule counts as 11 octets; its decoded form is 9, the allow is 10.
    const robots = "user-agent: a\nallow: /a?xxx/b/c\ndisallow: /a*%2Fb%2Fc\n";
    expect(allowed(robots, "a", "http://h.test/a?xxx/b/c")).toBe(false);
  });

  test("an allow rule matches either spelling too", () => {
    const robots = "user-agent: a\ndisallow: /\nallow: /a*%2Fb\n";
    expect(allowed(robots, "a", "http://h.test/a?x=%2Fb")).toBe(true);
  });
});

describe("differences from Google's parser", () => {
  // Google expects callers to escape URLs first. RFC 9309 says octets outside
  // ASCII must be encoded before comparison, and this library does that.
  test("URLs are escaped before matching", () => {
    const robots = "User-agent: FooBot\nDisallow: /\nAllow: /foo/bar/ツ\n";
    expect(allowed(robots, "FooBot", "http://foo.bar/foo/bar/ツ")).toBe(true);
  });

  // Google compares escapes literally and its test expects false here. Figure 4
  // of the RFC lists /foo/bar/%62%61%7A as matching /foo/bar/baz.
  test("escaped unreserved characters are decoded", () => {
    const robots = "User-agent: FooBot\nDisallow: /\nAllow: /foo/bar/%62%61%7A\n";
    expect(allowed(robots, "FooBot", "http://foo.bar/foo/bar/baz")).toBe(true);
    expect(allowed(robots, "FooBot", "http://foo.bar/foo/bar/%62%61%7A")).toBe(true);
  });

  // Google's rewrite grants access the file never stated. Typo tolerance only
  // reads a rule that is there; this one would invent a rule.
  test("index.html says nothing about its directory", () => {
    const robots = "User-Agent: *\nAllow: /allowed-slash/index.html\nDisallow: /\n";
    expect(allowed(robots, "foobot", "http://foo.com/allowed-slash/")).toBe(false);
    expect(allowed(robots, "foobot", "http://foo.com/allowed-slash/index.html")).toBe(true);
  });

  // Google cuts lines at 16,664 bytes. The file size limit already covers abuse.
  test("long lines are read in full", () => {
    const long = `/x/${"a".repeat(20_000)}`;
    const robots = `user-agent: FooBot\ndisallow: ${long}/qux\n`;
    expect(allowed(robots, "FooBot", `http://foo.bar${long}/fux`)).toBe(true);
    expect(allowed(robots, "FooBot", `http://foo.bar${long}/qux`)).toBe(false);
  });
});
