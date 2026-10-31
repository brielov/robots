import { describe, expect, test } from "bun:test";
import { collectRules, DEFAULT_MAX_BYTES, parseFile, type ParsedFile } from "../src/parse.ts";

function rulesFor(file: ParsedFile, token: string): string[] {
  return collectRules(file, file.agents.get(token) ?? []).map(
    (rule) => `${rule.allow ? "allow" : "disallow"} ${rule.pattern}`,
  );
}

const bytes = (...parts: (string | number[])[]): Uint8Array => {
  const encoder = new TextEncoder();
  const chunks = parts.map((part) =>
    typeof part === "string" ? encoder.encode(part) : Uint8Array.from(part),
  );
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

describe("line syntax", () => {
  test("empty input has no groups", () => {
    const file = parseFile("");
    expect(file.groups).toHaveLength(0);
    expect(file.sitemaps).toHaveLength(0);
  });

  test("reads directives and ignores case in names", () => {
    const file = parseFile("uSeR-aGeNt: FooBot\nAlLoW: /x/\ndIsAlLoW: /\n");
    expect(rulesFor(file, "foobot")).toEqual(["allow /x/", "disallow /"]);
  });

  test("keeps the case of patterns", () => {
    expect(rulesFor(parseFile("user-agent: a\ndisallow: /Foo/BAR\n"), "a")).toEqual([
      "disallow /Foo/BAR",
    ]);
  });

  test("tolerates whitespace around every part of a line", () => {
    const file = parseFile("  user-agent  :  a  \n\tdisallow\t:\t/x\t\n");
    expect(rulesFor(file, "a")).toEqual(["disallow /x"]);
  });

  test("accepts no whitespace after the colon", () => {
    expect(rulesFor(parseFile("User-Agent:a\nDisallow:/\nAllow:/x\n"), "a")).toEqual([
      "disallow /",
      "allow /x",
    ]);
  });

  test("a colon may appear inside a value", () => {
    expect(rulesFor(parseFile("user-agent: a\ndisallow: /x:y:z\n"), "a")).toEqual([
      "disallow /x:y:z",
    ]);
  });

  test("keeps whitespace inside a value when a colon is present", () => {
    expect(rulesFor(parseFile("user-agent: a\ndisallow: /x y\n"), "a")).toEqual(["disallow /x y"]);
  });

  test("accepts a missing colon for exactly two tokens", () => {
    expect(rulesFor(parseFile("user-agent a\ndisallow /\n"), "a")).toEqual(["disallow /"]);
    expect(rulesFor(parseFile("user-agent a\n  disallow \t /x  \n"), "a")).toEqual(["disallow /x"]);
  });

  test("ignores a missing colon when there are more than two tokens", () => {
    expect(rulesFor(parseFile("user-agent a\ndisallow /x y\n"), "a")).toEqual([]);
  });

  test("ignores a lone word", () => {
    expect(rulesFor(parseFile("user-agent a\ndisallow\nallow /x\n"), "a")).toEqual(["allow /x"]);
  });

  test("ignores a line with an empty key", () => {
    expect(rulesFor(parseFile("user-agent: a\n: /x\ndisallow: /y\n"), "a")).toEqual([
      "disallow /y",
    ]);
  });

  test("requires directive names to match exactly", () => {
    const file = parseFile(
      "user-agent: a\nallowed: /x\ndisallowance: /y\nuser-agents: b\ndisallow: /z\n",
    );
    expect(rulesFor(file, "a")).toEqual(["disallow /z"]);
    expect(file.agents.has("b")).toBe(false);
  });

  test("a colon inside a comment does not count as the separator", () => {
    expect(rulesFor(parseFile("user-agent a # note: yes\ndisallow /x # a: b\n"), "a")).toEqual([
      "disallow /x",
    ]);
  });
});

describe("whitespace and control characters", () => {
  test("trims vertical tabs and form feeds around keys and values", () => {
    const file = parseFile("\vuser-agent\f:\va\f\n\fdisallow:\v/x\f\n");
    expect(rulesFor(file, "a")).toEqual(["disallow /x"]);
  });

  test("only space and tab can replace a missing colon", () => {
    expect(rulesFor(parseFile("user-agent: a\ndisallow\v/x\n"), "a")).toEqual([]);
    expect(rulesFor(parseFile("user-agent: a\ndisallow\f/x\n"), "a")).toEqual([]);
    expect(parseFile("user-agent\vfoo\n").agents.size).toBe(0);
  });

  test("a vertical tab between tokens is not a separator", () => {
    expect(rulesFor(parseFile("user-agent: a\ndisallow \v /x\n"), "a")).toEqual([]);
  });

  test("a vertical tab does not count as a third token", () => {
    expect(rulesFor(parseFile("user-agent: a\ndisallow /x\vy\n"), "a")).toEqual(["disallow /x\vy"]);
  });

  test("NUL ends a line's content", () => {
    const file = parseFile("user-agent: a\ndisallow: /x\0y\nallow: /z\n");
    expect(rulesFor(file, "a")).toEqual(["disallow /x", "allow /z"]);
  });

  test("text after a NUL is discarded", () => {
    const file = parseFile("user-agent: a\ndisallow: /x\0allow: /y\n");
    expect(rulesFor(file, "a")).toEqual(["disallow /x"]);
  });

  test("NUL cannot stand in for the space in 'user agent'", () => {
    expect(parseFile("user\0agent: x\n").agents.size).toBe(0);
  });

  test("a lone word does not end a user-agent run", () => {
    const file = parseFile("user-agent: a\ndisallow\nuser-agent: b\ndisallow: /x\n");
    expect(file.groups).toHaveLength(1);
    expect(rulesFor(file, "a")).toEqual(["disallow /x"]);
  });

  test("a lone user-agent word does not open a group", () => {
    expect(parseFile("user-agent\ndisallow: /x\n").groups).toHaveLength(0);
  });
});

describe("line endings", () => {
  const body = ["User-Agent: foo", "Allow: /some/path", "User-Agent: bar", "", "", "Disallow: /"];

  test.each([
    ["LF", body.join("\n")],
    ["CRLF", body.join("\r\n")],
    ["CR", body.join("\r")],
    ["trailing LF", `${body.join("\n")}\n`],
    ["mixed", "User-Agent: foo\nAllow: /some/path\r\nUser-Agent: bar\n\r\n\nDisallow: /"],
  ])("%s", (_name, text) => {
    const file = parseFile(text);
    expect(rulesFor(file, "foo")).toEqual(["allow /some/path"]);
    expect(rulesFor(file, "bar")).toEqual(["disallow /"]);
  });
});

describe("comments", () => {
  test("strips full-line and inline comments", () => {
    const file = parseFile(
      "# header\nuser-agent: a # who\n# disallow: /\ndisallow: /x#y\nallow: /z # why\n",
    );
    expect(rulesFor(file, "a")).toEqual(["disallow /x", "allow /z"]);
  });

  test("a comment on the last line needs no newline", () => {
    expect(rulesFor(parseFile("user-agent: a\ndisallow: /x # end"), "a")).toEqual(["disallow /x"]);
  });

  test("a comment leaves no value behind", () => {
    const file = parseFile("user-agent: a\ndisallow: # nothing\n");
    expect(rulesFor(file, "a")).toEqual([]);
  });
});

describe("groups", () => {
  test("user-agent lines before a rule share a group", () => {
    const file = parseFile("user-agent: a\nuser-agent: b\ndisallow: /x\n");
    expect(file.groups).toHaveLength(1);
    expect(rulesFor(file, "a")).toEqual(["disallow /x"]);
    expect(rulesFor(file, "b")).toEqual(["disallow /x"]);
  });

  test("blank lines do not split a group", () => {
    const file = parseFile("user-agent: a\n\nuser-agent: b\n\ndisallow: /x\n\nallow: /y\n");
    expect(file.groups).toHaveLength(1);
    expect(rulesFor(file, "b")).toEqual(["disallow /x", "allow /y"]);
  });

  test("a user-agent line after a rule opens a new group", () => {
    const file = parseFile("user-agent: a\ndisallow: /x\nuser-agent: b\ndisallow: /y\n");
    expect(file.groups).toHaveLength(2);
    expect(rulesFor(file, "a")).toEqual(["disallow /x"]);
    expect(rulesFor(file, "b")).toEqual(["disallow /y"]);
  });

  test("an empty rule still closes the user-agent run", () => {
    const file = parseFile("user-agent: a\ndisallow:\nuser-agent: b\ndisallow: /y\n");
    expect(file.groups).toHaveLength(2);
    expect(rulesFor(file, "a")).toEqual([]);
    expect(rulesFor(file, "b")).toEqual(["disallow /y"]);
  });

  test("rules before the first user-agent are ignored", () => {
    const file = parseFile("disallow: /x\nallow: /y\nuser-agent: a\ndisallow: /z\n");
    expect(rulesFor(file, "a")).toEqual(["disallow /z"]);
  });

  test("the same agent in separate groups keeps every group", () => {
    const file = parseFile(
      "user-agent: a\ndisallow: /x\nuser-agent: b\ndisallow: /y\nuser-agent: A\nallow: /z\n",
    );
    expect(rulesFor(file, "a")).toEqual(["disallow /x", "allow /z"]);
  });

  test("repeating an agent within a group does not repeat its rules", () => {
    const file = parseFile("user-agent: a\nuser-agent: A\ndisallow: /x\n");
    expect(rulesFor(file, "a")).toEqual(["disallow /x"]);
  });

  test.each(["sitemap: https://a.test/s.xml", "unknown-directive: value", "crawl-delay: 1"])(
    "%s does not end a group",
    (line) => {
      const file = parseFile(`user-agent: a\n${line}\nuser-agent: b\ndisallow: /\n`);
      expect(file.groups).toHaveLength(1);
      expect(rulesFor(file, "a")).toEqual(["disallow /"]);
      expect(rulesFor(file, "b")).toEqual(["disallow /"]);
    },
  );
});

describe("user-agent values", () => {
  test("lowercases tokens", () => {
    expect(parseFile("user-agent: FooBot\n").agents.has("foobot")).toBe(true);
  });

  test("keeps hyphens and underscores", () => {
    const { agents } = parseFile("user-agent: foo-bar_baz\n");
    expect(agents.has("foo-bar_baz")).toBe(true);
  });

  test.each([
    ["Foo Bar", "foo"],
    ["Foo/1.2", "foo"],
    ["Foo2", "foo"],
    ["Foo*", "foo"],
  ])("reduces %s to the leading token", (value, token) => {
    expect([...parseFile(`user-agent: ${value}\n`).agents.keys()]).toEqual([token]);
  });

  test.each(["*", "* extra", "*\tmore"])("treats %s as the global agent", (value) => {
    expect([...parseFile(`user-agent: ${value}\n`).agents.keys()]).toEqual(["*"]);
  });

  test("a star glued to other text names nobody", () => {
    expect(parseFile("user-agent: *foo\n").agents.size).toBe(0);
  });

  test("a value with no token names nobody but still starts a group", () => {
    const file = parseFile("user-agent: 123\ndisallow: /x\n");
    expect(file.agents.size).toBe(0);
    expect(file.groups).toHaveLength(1);
  });

  test("an empty value still starts a group", () => {
    const file = parseFile("user-agent:\ndisallow: /x\nuser-agent: a\ndisallow: /y\n");
    expect(file.groups).toHaveLength(2);
    expect(rulesFor(file, "a")).toEqual(["disallow /y"]);
  });

  test("handles a token named after an Object.prototype key", () => {
    const { agents } = parseFile("user-agent: __proto__\nuser-agent: constructor\n");
    expect(agents.has("__proto__")).toBe(true);
    expect(agents.has("constructor")).toBe(true);
  });
});

describe("typos", () => {
  test.each(["useragent", "user agent", "USERAGENT"])("%s means user-agent", (key) => {
    expect(rulesFor(parseFile(`${key}: a\ndisallow: /x\n`), "a")).toEqual(["disallow /x"]);
  });

  test.each(["dissallow", "dissalow", "disalow", "diasllow", "disallaw", "DISALOW"])(
    "%s means disallow",
    (key) => {
      expect(rulesFor(parseFile(`user-agent: a\n${key}: /x\n`), "a")).toEqual(["disallow /x"]);
    },
  );

  test.each(["sitemap", "site-map", "SiteMap"])("%s means sitemap", (key) => {
    expect(parseFile(`${key}: https://a.test/s.xml\n`).sitemaps).toEqual(["https://a.test/s.xml"]);
  });

  test("allow typos are not accepted", () => {
    expect(rulesFor(parseFile("user-agent: a\nalow: /x\n"), "a")).toEqual([]);
  });
});

describe("sitemaps", () => {
  test("collects sitemaps from anywhere in the file, in order", () => {
    const file = parseFile(
      "Sitemap: https://a.test/1.xml\nuser-agent: a\nSitemap: https://a.test/2.xml\ndisallow: /\nSitemap: https://a.test/3.xml",
    );
    expect(file.sitemaps).toEqual([
      "https://a.test/1.xml",
      "https://a.test/2.xml",
      "https://a.test/3.xml",
    ]);
  });

  test("ignores empty sitemap lines", () => {
    expect(parseFile("sitemap:\nsitemap:   \n").sitemaps).toEqual([]);
  });

  test("keeps the colon of the URL scheme", () => {
    expect(parseFile("sitemap https://a.test/s.xml\n").sitemaps).toEqual([]);
    expect(parseFile("sitemap:https://a.test/s.xml\n").sitemaps).toEqual(["https://a.test/s.xml"]);
  });
});

describe("crawl-delay", () => {
  const delay = (text: string) => parseFile(text).groups[0]?.crawlDelay;

  test.each([
    ["5", 5],
    ["0", 0],
    ["0.5", 0.5],
    [".5", 0.5],
    ["5.", 5],
  ])("reads %s", (value, expected) => {
    expect(delay(`user-agent: a\ncrawl-delay: ${value}\n`)).toBe(expected);
  });

  test.each([
    "",
    "soon",
    "-1",
    "-0",
    "+5",
    "Infinity",
    "5s",
    "0x10",
    "0b11",
    "0o7",
    "1e3",
    ".",
    "1.2.3",
  ])("ignores %j", (value) => {
    expect(delay(`user-agent: a\ncrawl-delay: ${value}\n`)).toBeUndefined();
  });

  test("ignores a delay too large to represent", () => {
    expect(delay(`user-agent: a\ncrawl-delay: ${"9".repeat(400)}\n`)).toBeUndefined();
  });

  test("keeps the largest delay in a group", () => {
    expect(delay("user-agent: a\ncrawl-delay: 2\ncrawl-delay: 9\ncrawl-delay: 4\n")).toBe(9);
  });

  test("ignores a delay outside a group", () => {
    const file = parseFile("crawl-delay: 5\nuser-agent: a\ndisallow: /\n");
    expect(file.groups[0]?.crawlDelay).toBeUndefined();
  });
});

describe("byte order marks", () => {
  test("skips a BOM in a string", () => {
    expect(rulesFor(parseFile("\uFEFFuser-agent: a\ndisallow: /x\n"), "a")).toEqual([
      "disallow /x",
    ]);
  });

  test.each([
    ["full", [0xef, 0xbb, 0xbf]],
    ["two bytes", [0xef, 0xbb]],
    ["one byte", [0xef]],
  ])("skips a %s BOM in bytes", (_name, prefix) => {
    const file = parseFile(bytes(prefix, "user-agent: a\ndisallow: /x\n"));
    expect(rulesFor(file, "a")).toEqual(["disallow /x"]);
  });

  test("a broken BOM garbles only the first line", () => {
    const file = parseFile(
      bytes([0xef, 0x11, 0xbf], "user-agent: a\nuser-agent: b\ndisallow: /x\n"),
    );
    expect(file.agents.has("a")).toBe(false);
    expect(rulesFor(file, "b")).toEqual(["disallow /x"]);
  });

  test("only the first BOM is skipped", () => {
    const text = "user-agent: a\nuser-agent: b\ndisallow: /x\n";
    const fromBytes = parseFile(bytes([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf], text));
    const fromString = parseFile(`\uFEFF\uFEFF${text}`);
    for (const file of [fromBytes, fromString]) {
      expect(file.agents.has("a")).toBe(false);
      expect(rulesFor(file, "b")).toEqual(["disallow /x"]);
    }
  });

  test("a BOM mid-file garbles only its own line", () => {
    const file = parseFile(
      bytes("user-agent: a\n", [0xef, 0xbb, 0xbf], "allow: /x\ndisallow: /y\n"),
    );
    expect(rulesFor(file, "a")).toEqual(["disallow /y"]);
  });
});

describe("byte input", () => {
  test("decodes UTF-8 values", () => {
    expect(rulesFor(parseFile(bytes("user-agent: a\ndisallow: /ツ\n")), "a")).toEqual([
      "disallow /ツ",
    ]);
  });

  test("bytes and strings give the same rules", () => {
    const text = "user-agent: a\r\ndisallow: /x # no\r\nallow: /y\r\nsitemap: https://a.test/s\r\n";
    const fromText = parseFile(text);
    const fromBytes = parseFile(bytes(text));
    expect(rulesFor(fromBytes, "a")).toEqual(rulesFor(fromText, "a"));
    expect(fromBytes.sitemaps).toEqual(fromText.sitemaps);
  });

  test("escapes the octets of a file that is not UTF-8", () => {
    const file = parseFile(bytes("user-agent: a\ndisallow: /caf", [0xe9], "\n"));
    expect(rulesFor(file, "a")).toEqual(["disallow /caf%E9"]);
  });

  test("escapes every octet above ASCII", () => {
    const file = parseFile(bytes("user-agent: a\ndisallow: /", [0x80, 0xff], "\n"));
    expect(rulesFor(file, "a")).toEqual(["disallow /%80%FF"]);
  });

  test("escapes every high byte correctly", () => {
    for (let byte = 0x80; byte <= 0xff; byte++) {
      const file = parseFile(bytes("user-agent: a\ndisallow: /", [0xc0, byte], "\n"));
      const escaped = `%${byte.toString(16).toUpperCase()}`;
      // 0xC0 is never valid UTF-8, which forces the escaping route.
      expect(rulesFor(file, "a")).toEqual([`disallow /%C0${escaped}`]);
    }
  });

  test("leaves ASCII alone when escaping a file", () => {
    const file = parseFile(bytes("user-agent: a\ndisallow: /a%b c\nallow: /", [0xff], "\n"));
    expect(rulesFor(file, "a")).toEqual(["disallow /a%b c", "allow /%FF"]);
  });

  test("accepts a view into a larger buffer", () => {
    const whole = bytes("garbage\nuser-agent: a\ndisallow: /x\n");
    expect(rulesFor(parseFile(whole.subarray(8)), "a")).toEqual(["disallow /x"]);
  });
});

describe("size limit", () => {
  const padded = (size: number, tail: string): string => {
    const head = "user-agent: a\ndisallow: /kept\n";
    return `${head}${"#".repeat(size - head.length - 1)}\n${tail}`;
  };

  test("the default limit is at least the 500 KiB the RFC requires", () => {
    expect(DEFAULT_MAX_BYTES).toBeGreaterThanOrEqual(500 * 1024);
  });

  test("reads everything at exactly the limit, even with no final newline", () => {
    const text = "user-agent: a\ndisallow: /x";
    expect(rulesFor(parseFile(text, { maxBytes: text.length }), "a")).toEqual(["disallow /x"]);
    expect(rulesFor(parseFile(bytes(text), { maxBytes: text.length }), "a")).toEqual([
      "disallow /x",
    ]);
  });

  test("drops rules past the limit", () => {
    const text = padded(200, "disallow: /dropped\n");
    expect(rulesFor(parseFile(text, { maxBytes: 200 }), "a")).toEqual(["disallow /kept"]);
    expect(rulesFor(parseFile(bytes(text), { maxBytes: 200 }), "a")).toEqual(["disallow /kept"]);
  });

  test("never keeps half a rule", () => {
    const text = padded(200, "allow: /a/b/c/d\n");
    for (const maxBytes of [201, 205, 210, 213]) {
      expect(rulesFor(parseFile(text, { maxBytes }), "a")).toEqual(["disallow /kept"]);
      expect(rulesFor(parseFile(bytes(text), { maxBytes }), "a")).toEqual(["disallow /kept"]);
    }
  });

  test("never splits a multi-byte character", () => {
    const text = "user-agent: a\ndisallow: /kept\nallow: /ツツツ\n";
    const encoded = bytes(text);
    for (let maxBytes = encoded.length - 2; maxBytes > 30; maxBytes--) {
      const file = parseFile(encoded, { maxBytes });
      expect(rulesFor(file, "a")).toEqual(["disallow /kept"]);
    }
  });

  test("a limit inside the first line reads nothing", () => {
    expect(parseFile("user-agent: a\ndisallow: /\n", { maxBytes: 4 }).groups).toHaveLength(0);
    expect(parseFile(bytes("user-agent: a\ndisallow: /\n"), { maxBytes: 4 }).groups).toHaveLength(
      0,
    );
  });

  test("a limit of zero reads nothing", () => {
    expect(parseFile("user-agent: a\n", { maxBytes: 0 }).groups).toHaveLength(0);
  });

  test("a limit inside the BOM reads nothing", () => {
    expect(parseFile("\uFEFFuser-agent: a\n", { maxBytes: 1 }).groups).toHaveLength(0);
    expect(
      parseFile(bytes([0xef, 0xbb, 0xbf], "user-agent: a\n"), { maxBytes: 2 }).groups,
    ).toHaveLength(0);
  });

  test("keeps a complete line when only its terminator is over the limit", () => {
    const text = "user-agent: a\ndisallow: /x\n";
    const maxBytes = text.length - 1;
    expect(rulesFor(parseFile(text, { maxBytes }), "a")).toEqual(["disallow /x"]);
    expect(rulesFor(parseFile(bytes(text), { maxBytes }), "a")).toEqual(["disallow /x"]);
    expect(rulesFor(parseFile(text, { maxBytes: maxBytes - 1 }), "a")).toEqual([]);
    expect(rulesFor(parseFile(bytes(text), { maxBytes: maxBytes - 1 }), "a")).toEqual([]);
  });

  test("finds line boundaries in CR-only files", () => {
    const text = "user-agent: a\rdisallow: /x\rallow: /yyyyyyyy\r";
    expect(rulesFor(parseFile(text, { maxBytes: 30 }), "a")).toEqual(["disallow /x"]);
    expect(rulesFor(parseFile(bytes(text), { maxBytes: 30 }), "a")).toEqual(["disallow /x"]);
  });

  test("keeps a complete line when only its CR is over the limit", () => {
    const text = "user-agent: a\rdisallow: /x\r";
    const maxBytes = text.length - 1;
    expect(rulesFor(parseFile(text, { maxBytes }), "a")).toEqual(["disallow /x"]);
    expect(rulesFor(parseFile(bytes(text), { maxBytes }), "a")).toEqual(["disallow /x"]);
  });

  test("keeps a complete line when the limit lands on the CR of a CRLF", () => {
    const text = "user-agent: a\r\ndisallow: /x\r\nallow: /y\r\n";
    const maxBytes = text.indexOf("\r\nallow");
    expect(rulesFor(parseFile(text, { maxBytes }), "a")).toEqual(["disallow /x"]);
    expect(rulesFor(parseFile(bytes(text), { maxBytes }), "a")).toEqual(["disallow /x"]);
  });

  test("a cut between CR and LF keeps the line", () => {
    const text = "user-agent: a\r\ndisallow: /x\r\nallow: /y\r\n";
    const maxBytes = text.indexOf("\nallow");
    expect(rulesFor(parseFile(text, { maxBytes }), "a")).toEqual(["disallow /x"]);
    expect(rulesFor(parseFile(bytes(text), { maxBytes }), "a")).toEqual(["disallow /x"]);
  });

  test("a limit past a BOM still skips the BOM", () => {
    const text = "\uFEFFuser-agent: a\ndisallow: /x\nallow: /yyyyyyyy\n";
    expect(rulesFor(parseFile(text, { maxBytes: 28 }), "a")).toEqual(["disallow /x"]);
  });

  test("applies the default limit when no options are given", () => {
    const text = padded(DEFAULT_MAX_BYTES, "disallow: /dropped\n");
    expect(rulesFor(parseFile(text), "a")).toEqual(["disallow /kept"]);
    expect(rulesFor(parseFile(bytes(text)), "a")).toEqual(["disallow /kept"]);
  });

  test("the default limit keeps a rule ending exactly on it", () => {
    const tail = "disallow: /last";
    const text = `${padded(DEFAULT_MAX_BYTES - tail.length, tail)}`;
    expect(text).toHaveLength(DEFAULT_MAX_BYTES);
    expect(rulesFor(parseFile(text), "a")).toEqual(["disallow /kept", "disallow /last"]);
  });

  test.each([Number.NaN, -1, -0.5, Number.NEGATIVE_INFINITY])(
    "rejects a limit of %p",
    (maxBytes) => {
      expect(() => parseFile("", { maxBytes })).toThrow(RangeError);
      expect(() => parseFile(new Uint8Array(), { maxBytes })).toThrow(RangeError);
    },
  );

  test("an infinite limit reads everything", () => {
    const text = padded(DEFAULT_MAX_BYTES + 100, "disallow: /last\n");
    const maxBytes = Number.POSITIVE_INFINITY;
    expect(rulesFor(parseFile(text, { maxBytes }), "a")).toEqual([
      "disallow /kept",
      "disallow /last",
    ]);
    expect(rulesFor(parseFile(bytes(text), { maxBytes }), "a")).toEqual([
      "disallow /kept",
      "disallow /last",
    ]);
  });

  test("rounds a fractional limit down, for strings and bytes alike", () => {
    const text = "user-agent: a\ndisallow: /x\nallow: /yyyyyyy\n";
    expect(rulesFor(parseFile(text, { maxBytes: 30.5 }), "a")).toEqual(["disallow /x"]);
    expect(rulesFor(parseFile(bytes(text), { maxBytes: 30.5 }), "a")).toEqual(["disallow /x"]);
    expect(rulesFor(parseFile(text, { maxBytes: 25.5 }), "a")).toEqual([]);
    expect(rulesFor(parseFile(bytes(text), { maxBytes: 25.5 }), "a")).toEqual([]);
  });
});

describe("laziness", () => {
  test("a rule's offsets point back into the source", () => {
    const file = parseFile("user-agent: a\ndisallow: /x\nallow: /y\n");
    expect(file.source.slice(file.spans[0], file.spans[1])).toBe("/x");
    expect(file.spans[3]).toBeLessThan(0);
    expect(file.source.slice(file.spans[2], -(file.spans[3] as number))).toBe("/y");
  });
});
