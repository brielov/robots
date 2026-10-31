# robots

[![CI](https://github.com/brielov/robots/actions/workflows/ci.yml/badge.svg)](https://github.com/brielov/robots/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A small, fast robots.txt parser and matcher for TypeScript. It has no dependencies, follows
[RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html), and is about 4 KB gzipped.

```ts
import { parse } from "robots";

const robots = parse(`
  User-agent: *
  Disallow: /private/
  Allow: /private/press-kit
  Disallow: /*.pdf$
  Sitemap: https://example.com/sitemap.xml
`);

const bot = robots.agent("MyBot");

bot.isAllowed("https://example.com/about"); // true
bot.isAllowed("https://example.com/private/notes"); // false
bot.isAllowed("https://example.com/private/press-kit"); // true, the longest rule wins
bot.isAllowed("https://example.com/report.pdf"); // false
```

- **Fast.** 17 to 24 times faster per URL than `robots-parser`, and prefix rules don't slow it down
  as files grow. See [Performance](#performance).
- **Correct.** Tested with Google's robots.txt test suite and the RFC's examples, and fuzzed against
  reference matchers. Where Google and the RFC disagree it follows the RFC, as listed under
  [Behaviour](#behaviour).
- **Safe on untrusted files.** Patterns never become regular expressions, so a hostile file can't
  cause catastrophic backtracking. Input is capped, and a truncated rule can never become a more
  permissive one.
- **Hard to get past.** URLs are canonicalized the way an HTTP client would send them, so
  `/public/../private`, `%2e%2e` and escaped characters are judged as what they really are.
- **Yours to fetch.** It parses text and answers questions. It doesn't touch the network, so it
  works with any HTTP client.

## Install

robots is not published to npm. Install it directly from GitHub and pin to a tag:

```sh
bun add github:brielov/robots#v0.1.0
```

The package ships its TypeScript source (`exports` point at `src/`), so it needs a runtime or
bundler that compiles TypeScript in dependencies, such as Bun. Node won't strip types inside
`node_modules`; for plain Node, clone the repository and run `bun run build`, which writes ESM and
`.d.ts` files to `dist/`.

The code itself is runtime-agnostic. CI runs the built package on Bun, Node and Deno. Its only
requirement is `TextDecoder`, to read `Uint8Array` input, so browsers and Cloudflare Workers should
work as well, although neither is tested yet.

## Usage

A crawler fetches the file, handles failure, and then asks about each URL:

```ts
import { parse, robotsForStatus } from "robots";

const response = await fetch("https://example.com/robots.txt");
const robots = response.ok ? parse(await response.text()) : robotsForStatus(response.status);

const bot = robots.agent("MyBot");

for (const url of queue) {
  if (bot.isAllowed(url)) await crawl(url);
}

bot.crawlDelay; // seconds, or undefined
robots.sitemaps; // ["https://example.com/sitemap.xml"]
```

Hold on to the result of `agent()`. It compiles that agent's rules on first use and caches them,
and a crawler typically makes thousands of decisions per file.

Cache parsed files per origin too. The RFC says not to keep one for more than 24 hours, unless the
file has since become unreachable.

## API

### `parse(input, options?)`

Parses a `string` or `Uint8Array` and returns a `Robots`. File content never makes it throw: lines
it can't understand are ignored.

| Option     | Default | Description                                                                                                 |
| ---------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `maxBytes` | 500 KiB | Input past this is dropped at a line boundary. `Infinity` disables it. Negative or `NaN` is a `RangeError`. |

For `Uint8Array` input the limit counts bytes. For a string it counts UTF-16 code units.

### `robotsForStatus(status)`

Returns the policy for a fetch that gave no usable file, following RFC 9309:

| Status                  | Policy              | Why                                                        |
| ----------------------- | ------------------- | ---------------------------------------------------------- |
| 400 to 499, except 429  | Allow everything    | The file is unavailable.                                   |
| 429 and everything else | Disallow everything | Being rate limited or failing says nothing about the file. |

Don't pass a successful status. Parse the body instead.

### `Robots`

| Member        | Description                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent(name)` | The rules for a product token such as `"Googlebot"`, compared case-insensitively. Pass the token, not a whole `User-Agent` header: a name no group matches gets the `*` group. |
| `sitemaps`    | Every `Sitemap` URL in the file, in order.                                                                                                                                     |

### `Agent`

| Member                | Description                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isAllowed(url)`      | Takes a string or `URL`, and never throws for either. The scheme may be left out. Only the path and query are judged, so use the file from that URL's own origin. |
| `isAllowedPath(path)` | Takes a path with an optional query. Faster if you already have one.                                                                                              |
| `crawlDelay`          | The largest `Crawl-delay` in the agent's groups, in seconds. robots.txt doesn't standardize this directive.                                                       |

## Behaviour

Where RFC 9309 and Google's [robotstxt](https://github.com/google/robotstxt) parser agree, robots
does the same. It keeps Google's line-level leniency too, such as the misspellings `disalow` and
`user agent`, a missing colon, and a partial byte order mark.

It differs from Google's parser in these ways, usually because the RFC says so:

- URLs are canonicalized before matching, so callers don't have to escape them first.
- `%62` matches `b`, and `%2A` matches a literal `*`, as figures 4 and 6 of the RFC require.
- `:`, `/`, `?`, `@`, `[` and `]` match in either spelling inside a query, as figure 4 shows for
  `:` and `/`. In a path, `%2F` and `/` stay distinct, and so do sub-delims like `%2C` and `,`
  everywhere.
- `'` matches `%27`, because URL parsers escape it in queries.
- Priority is the length of the canonical pattern, so `/%62` counts as 2 octets.
- `/robots.txt` is always allowed, as the RFC says, even under `Disallow: /`.
- Directive names must match in full, so `Disallowed: /x` is ignored.
- Allowing `/dir/index.html` doesn't allow `/dir/`, since the file never said so.
- Long lines aren't cut off. The size limit already handles abuse.

Fragments are ignored, and dot segments are resolved, so `/public/../private` is judged as
`/private`.

## Performance

Measured on 65 real robots.txt files from major sites, against
[`robots-parser`](https://github.com/samclarke/robots-parser) 3.0.1, on one machine:

| Per URL or file      | robots on Bun | robots on Node | `robots-parser` on Bun | `robots-parser` on Node |
| -------------------- | ------------- | -------------- | ---------------------- | ----------------------- |
| `isAllowed`, per URL | 267 ns        | 428 ns         | 6.42 µs                | 7.14 µs                 |
| First use, per file  | 72 µs         | 100 µs         | 508 µs                 | 642 µs                  |

First use means parsing a file and making one decision. It's the fair way to compare the two,
because robots defers rule work that `robots-parser` does while parsing.

A few things make that possible:

- Parsing records offsets instead of copying strings, and only the agent you ask for is compiled.
- Prefix rules are sorted, so one binary search finds the best match among them, however many
  there are. A file with 10,000 of them costs about the same per URL as a typical file.
- Each wildcard rule has a mask of the characters it needs, which rejects most rules without
  searching the URL at all.
- Most URLs are already canonical, so they're scanned once and not rewritten. Matching one
  allocates almost nothing.

The worst case is a file built to be slow: 1,000 wildcard rules that each nearly match a 4 KB URL
take about 290 µs on Bun and 3 ms on Node for that URL. Cost grows with path length times pattern
length, the same bound as Google's matcher.

To reproduce these, run `bun run bench:corpus` to download the files, then `bun run bench` and
`bun run bench:node`. Compare two versions with `bun bench/spread.ts`, which uses fresh processes,
since one process can't tell a small change from noise.

## Contributing

Issues and pull requests are welcome. You'll need [Bun](https://bun.com) 1.4 or newer.

```sh
bun install
bun test
bun run typecheck
bun run lint
bun run fmt
```

A few things are worth knowing:

- A decision that disagrees with the RFC is a bug, so please include the robots.txt and the URL.
- `src/` has to stay runtime-agnostic. `tsconfig.lib.json` type-checks it without Bun or Node types,
  and `bun run test:dist` runs the built package on both.
- Performance claims need numbers from `bun bench/spread.ts` on both Bun and Node, because their
  engines can disagree.

## License

[MIT](LICENSE)
