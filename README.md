# robots

A small, fast robots.txt parser and matcher for TypeScript. It has no dependencies, and the only
thing it needs from its runtime is `TextDecoder`, to read `Uint8Array` input.

```ts
import { parse, robotsForStatus } from "robots";

const response = await fetch("https://example.com/robots.txt");
const robots = response.ok ? parse(await response.text()) : robotsForStatus(response.status);

const bot = robots.agent("MyBot");

bot.isAllowed("https://example.com/a?b=1"); // a full URL
bot.isAllowedPath("/a?b=1"); // faster, if you already have the path
bot.crawlDelay; // seconds, or undefined
robots.sitemaps; // ["https://example.com/sitemap.xml"]
```

The library doesn't fetch anything. You bring the bytes, so it fits any HTTP client and runtime.

Hold on to the result of `agent()`. It compiles that agent's rules on first use and caches them,
and a crawler typically makes thousands of decisions per file.

## API

### `parse(input, options?)`

Parses a `string` or `Uint8Array`. File content never makes it throw: lines it can't understand
are ignored. `options.maxBytes` limits the input, 500 KiB by default, and input past the limit is
dropped at a line boundary so a rule is never cut short. `Infinity` disables the limit, and a
negative or `NaN` value throws a `RangeError`.

### `robotsForStatus(status)`

The policy for a fetch that gave no usable file, per RFC 9309: 400 to 499 allows everything, and
anything else disallows everything. 429 counts as a server error, because being rate limited says
nothing about the file. Don't pass a successful status; parse the body instead.

### `Robots`

- `agent(name)`: the rules for a product token such as `"Googlebot"`, compared case-insensitively.
  Pass the token, not a whole `User-Agent` header: a name no group matches gets the `*` group.
- `sitemaps`: every `Sitemap` URL in the file.

### `Agent`

- `isAllowed(url)`: takes a string or `URL`, and never throws for either. The scheme may be left
  out, and a string that can't be a URL is read as leniently as possible. Only the path and query
  are judged, so use the file from that URL's own origin.
- `isAllowedPath(path)`: takes a path with an optional query.
- `crawlDelay`: the largest `Crawl-delay` in the agent's groups. robots.txt doesn't standardize it.

## Behaviour

This follows [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html), and passes Google's
[robotstxt](https://github.com/google/robotstxt) test suite except where the two disagree.

It keeps Google's line-level leniency, such as the misspellings `disalow` and `user agent`, a
missing colon, and a partial byte order mark. It differs from Google's parser in these ways:

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

## Development

```sh
bun test
bun run typecheck
bun run lint
bun run build        # dist/, then: bun run test:dist
bun run bench:corpus # downloads real robots.txt files, then: bun run bench
```
