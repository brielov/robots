/**
 * Sweeps whole input domains instead of picking examples: every octet, every
 * BMP code unit, every ASCII character at each position that treats characters
 * differently, and every near miss of every directive name. Expectations come
 * from the specification or from `TextEncoder`, never from the code under test.
 */
import { describe, expect, test } from "bun:test";
import { canonicalPath, canonicalPattern } from "../src/canonical.ts";
import { parse } from "../src/index.ts";

const ASCII = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code));
const OCTETS = Array.from({ length: 256 }, (_, octet) => octet);

const hexOf = (octet: number): string => octet.toString(16).padStart(2, "0");
const isUnreserved = (char: string): boolean => /^[A-Za-z0-9._~-]$/.test(char);
const isQueryDelimiter = (char: string): boolean => ":/?@[]".includes(char);
const isHexDigit = (char: string): boolean => /^[0-9a-fA-F]$/.test(char);

/** Every spelling of an escape: `%aF`, `%Af`, and so on. */
const spellings = (octet: number): string[] => {
  const hex = hexOf(octet);
  const [high, low] = [hex.charAt(0), hex.charAt(1)];
  return [
    `%${high}${low}`,
    `%${high.toUpperCase()}${low}`,
    `%${high}${low.toUpperCase()}`,
    `%${high.toUpperCase()}${low.toUpperCase()}`,
  ];
};

describe("every escape sequence", () => {
  const inPath = (octet: number): string => {
    const char = String.fromCharCode(octet);
    return octet < 0x80 && isUnreserved(char) ? char : `%${hexOf(octet).toUpperCase()}`;
  };
  const inQuery = (octet: number): string => {
    const char = String.fromCharCode(octet);
    return octet < 0x80 && isQueryDelimiter(char) ? char : inPath(octet);
  };

  test.each(OCTETS)("octet %d", (octet) => {
    for (const escape of spellings(octet)) {
      expect(canonicalPath(`/a${escape}b`)).toBe(`/a${inPath(octet)}b`);
      expect(canonicalPattern(`/a${escape}b`)).toBe(`/a${inPath(octet)}b`);
      expect(canonicalPath(`/a?b${escape}c`)).toBe(`/a?b${inQuery(octet)}c`);
      expect(canonicalPattern(`/a?b${escape}c`)).toBe(`/a?b${inQuery(octet)}c`);
    }
  });
});

describe("every character that isn't a hex digit", () => {
  // What follows a stray percent reads as if the percent were not there.
  const tailOf = (text: string): string => canonicalPath(`/${text}`).slice(1);

  const IGNORED = "\t\n\r";

  test.each(ASCII.filter((char) => !isHexDigit(char) && !IGNORED.includes(char)))("%j", (char) => {
    expect(canonicalPath(`/a%${char}0b`)).toBe(`/a%${tailOf(`${char}0b`)}`);
    expect(canonicalPath(`/a%0${char}b`)).toBe(`/a%0${tailOf(`${char}b`)}`);
  });

  test.each(IGNORED.split(""))("%j goes first, so an escape can form around it", (char) => {
    expect(canonicalPath(`/a%${char}4${char}1b`)).toBe("/aAb");
  });
});

describe("every ASCII character in a path", () => {
  const SAFE = /^[A-Za-z0-9\-._~!&()+,/:;=@[\]]$/;
  const expected = (char: string): string => {
    if (char === "\t" || char === "\n" || char === "\r") return "/ab";
    if (char === "#") return "/a";
    if (char === "?") return "/a?b";
    if (char === "\\") return "/a/b";
    if (char === "%") return "/a%b";
    if (SAFE.test(char)) return `/a${char}b`;
    return `/a%${hexOf(char.charCodeAt(0)).toUpperCase()}b`;
  };

  test.each(ASCII)("%j", (char) => {
    expect(canonicalPath(`/a${char}b`)).toBe(expected(char));
  });
});

describe("every printable character, in a rule and a path alike", () => {
  // `#` starts a comment and `*` is a wildcard. A client turns `\\` into `/` in
  // a request, so a rule can't name it: that one stays apart on purpose.
  const LITERAL = ASCII.slice(0x21, 0x7f).filter((char) => !"#*\\\\".includes(char));

  test.each(LITERAL)("%j", (char) => {
    const agent = parse(`user-agent: *\ndisallow: /a${char}b\n`).agent("x");
    expect(agent.isAllowedPath(`/a${char}b`)).toBe(false);
    expect(agent.isAllowed(`https://a.test/a${char}b`)).toBe(false);
  });

  test("a rule can't name a backslash", () => {
    const agent = parse("user-agent: *\ndisallow: /a\\b\n").agent("x");
    expect(agent.isAllowedPath("/a\\b")).toBe(true);
    expect(agent.isAllowedPath("/a%5Cb")).toBe(false);
  });
});

describe("every UTF-16 code unit", () => {
  const encoder = new TextEncoder();
  const escaped = (text: string): string =>
    Array.from(encoder.encode(text), (octet) => `%${hexOf(octet).toUpperCase()}`).join("");

  test("matches TextEncoder, including lone surrogates and the plane boundary", () => {
    for (let code = 0x80; code <= 0xffff; code++) {
      const char = String.fromCharCode(code);
      const path = canonicalPath(`/a${char}b`);
      if (path !== `/a${escaped(char)}b`) throw new Error(`U+${code.toString(16)} gave ${path}`);
    }
  });

  test.each([0x10000, 0x1f600, 0xfffff, 0x10ffff])("code point %d is one character", (point) => {
    const char = String.fromCodePoint(point);
    expect(canonicalPath(`/a${char}b`)).toBe(`/a${escaped(char)}b`);
  });
});

describe("where the URL parser's whitespace ends", () => {
  test.each(ASCII.slice(0, 0x21))("%j is trimmed", (char) => {
    expect(canonicalPath(`/a b${char}`)).toBe("/a%20b");
    expect(canonicalPath(`${char}/a b`)).toBe("/a%20b");
  });

  test("the next character up is not", () => {
    expect(canonicalPath("/a b!")).toBe("/a%20b!");
    expect(canonicalPath("!/a b")).toBe("/!/a%20b");
  });
});

describe("a pattern that begins with its query", () => {
  test("still gets query treatment", () => {
    expect(canonicalPattern("?a%2Fb")).toBe("?a/b");
  });

  test("keeps its end anchor", () => {
    expect(canonicalPattern("?a$")).toBe("?a$");
  });
});

describe("every near miss of every directive name", () => {
  /** Observes what a line is taken for, through the public API alone. */
  const kindOf = (key: string): string => {
    const seen: string[] = [];
    if (parse(`user-agent: a\ndisallow: /\n${key}: /x\n`).agent("a").isAllowedPath("/x")) {
      seen.push("allow");
    }
    if (!parse(`user-agent: a\n${key}: /x\n`).agent("a").isAllowedPath("/x")) {
      seen.push("disallow");
    }
    if (!parse(`${key}: a\ndisallow: /\n`).agent("a").isAllowedPath("/")) seen.push("user-agent");
    if (parse(`${key}: /x\n`).sitemaps.length === 1) seen.push("sitemap");
    if (parse(`user-agent: a\n${key}: 7\n`).agent("a").crawlDelay === 7) seen.push("crawl-delay");
    return seen.join();
  };

  const KEYS: Record<string, string> = {
    allow: "allow",
    disallow: "disallow",
    dissallow: "disallow",
    dissalow: "disallow",
    disalow: "disallow",
    diasllow: "disallow",
    disallaw: "disallow",
    "user-agent": "user-agent",
    useragent: "user-agent",
    "user agent": "user-agent",
    sitemap: "sitemap",
    "site-map": "sitemap",
    "crawl-delay": "crawl-delay",
  };
  const expectedKind = (key: string): string => KEYS[key.toLowerCase()] ?? "";

  const LETTERS = "abcdefghijklmnopqrstuvwxyz-";

  describe.each(Object.keys(KEYS))("%s", (key) => {
    test("is recognized in any case", () => {
      const alternating = key
        .split("")
        .map((char, index) => (index % 2 === 0 ? char.toUpperCase() : char))
        .join("");
      for (const spelling of [key, key.toUpperCase(), alternating]) {
        expect(kindOf(spelling)).toBe(KEYS[key] as string);
      }
    });

    test("with any one character replaced", () => {
      for (let i = 0; i < key.length; i++) {
        for (const char of LETTERS) {
          const candidate = key.slice(0, i) + char + key.slice(i + 1);
          expect(`${candidate}: ${kindOf(candidate)}`).toBe(
            `${candidate}: ${expectedKind(candidate)}`,
          );
        }
      }
    });

    test("with any one character removed", () => {
      for (let i = 0; i < key.length; i++) {
        const candidate = key.slice(0, i) + key.slice(i + 1);
        expect(`${candidate}: ${kindOf(candidate)}`).toBe(
          `${candidate}: ${expectedKind(candidate)}`,
        );
      }
    });

    test("with one character added", () => {
      for (let i = 0; i <= key.length; i++) {
        const candidate = `${key.slice(0, i)}x${key.slice(i)}`;
        expect(`${candidate}: ${kindOf(candidate)}`).toBe(
          `${candidate}: ${expectedKind(candidate)}`,
        );
      }
    });
  });
});

describe("every ASCII character in a user-agent token", () => {
  const isTokenChar = (char: string): boolean => /^[A-Za-z_-]$/.test(char);

  test.each(ASCII)("%j", (char) => {
    const robots = parse(`user-agent: foo${char}bar\ndisallow: /\n`);
    if (isTokenChar(char)) {
      expect(robots.agent(`foo${char}bar`).isAllowedPath("/")).toBe(false);
      expect(robots.agent("foo").isAllowedPath("/")).toBe(true);
    } else {
      expect(robots.agent("foo").isAllowedPath("/")).toBe(false);
      expect(robots.agent("foobar").isAllowedPath("/")).toBe(true);
    }
  });
});

describe("the default size limit", () => {
  const LIMIT = 500 * 1024;
  const HEAD = "user-agent: *\n";

  /** A file of exactly `size` units whose last rule is `disallow: /x`. */
  const fileOf = (size: number): string => {
    const rule = "disallow: /x";
    return `${HEAD}#${"-".repeat(size - HEAD.length - rule.length - 2)}\n${rule}`;
  };
  const inputs = (text: string): [string, string | Uint8Array][] => [
    ["string", text],
    ["bytes", new TextEncoder().encode(text)],
  ];

  test("is 500 KiB, as RFC 9309 requires at minimum", () => {
    for (const [, input] of inputs(fileOf(LIMIT))) {
      expect(parse(input).agent("a").isAllowedPath("/x")).toBe(false);
    }
  });

  test("one more unit drops the last line", () => {
    for (const [, input] of inputs(fileOf(LIMIT + 1))) {
      expect(parse(input).agent("a").isAllowedPath("/x")).toBe(true);
    }
  });

  test("a newline just past the limit keeps the line", () => {
    for (const [, input] of inputs(`${fileOf(LIMIT)}\n`)) {
      expect(parse(input).agent("a").isAllowedPath("/x")).toBe(false);
    }
  });
});

describe("a file that isn't UTF-8", () => {
  test("escapes only high bytes, and DEL is not one", () => {
    const bytes = Uint8Array.from([
      ...new TextEncoder().encode("sitemap: https://a.test/"),
      0x7f,
      0xff,
      0x0a,
    ]);
    expect(parse(bytes).sitemaps).toEqual(["https://a.test/\x7f%FF"]);
  });
});

describe("a rule that starts with a wildcard", () => {
  const blocks = (rule: string, path: string): boolean =>
    !parse(`user-agent: *\ndisallow: ${rule}\n`).agent("a").isAllowedPath(path);

  test("a middle segment may match at the very start of the path", () => {
    expect(blocks("*/x*%2Fy", "/x?a=%2Fy")).toBe(true);
  });

  test("a final segment may match at the very start of the path", () => {
    expect(blocks("*/a%2Fb", "/a%2Fb?x")).toBe(true);
  });
});
