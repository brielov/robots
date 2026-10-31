// Runs the built package using nothing but the language, so it works in any
// runtime. `bun run build` first.
import { parse, robotsForStatus } from "../../dist/index.js";

function check(name, actual, expected) {
  if (actual !== expected) throw new Error(`${name}: got ${actual}, expected ${expected}`);
}

const text = `Sitemap: https://a.test/sitemap.xml
User-agent: *
Crawl-delay: 2
Disallow: /private/
Allow: /private/ok
Disallow: /*.pdf$
`;

const robots = parse(text);
const bot = robots.agent("MyBot");
check("sitemap", robots.sitemaps[0], "https://a.test/sitemap.xml");
check("crawl delay", bot.crawlDelay, 2);
check("public", bot.isAllowed("https://a.test/page"), true);
check("private", bot.isAllowed("https://a.test/private/x"), false);
check("longest match", bot.isAllowed("https://a.test/private/ok"), true);
check("wildcard", bot.isAllowed("https://a.test/a/b.pdf"), false);
check("URL object", bot.isAllowed(new URL("https://a.test/private/x")), false);
check("path", bot.isAllowedPath("/private/x"), false);
check("non-ASCII", parse("user-agent: *\ndisallow: /ツ\n").agent("a").isAllowedPath("/ツ"), false);

const encoded = new TextEncoder().encode(text);
check("bytes", parse(encoded).agent("MyBot").isAllowedPath("/private/x"), false);
const latin1 = Uint8Array.from([
  ...new TextEncoder().encode("user-agent: *\ndisallow: /caf"),
  0xe9,
]);
check("invalid UTF-8", parse(latin1).agent("a").isAllowedPath("/caf%E9"), false);

check("404", robotsForStatus(404).agent("a").isAllowedPath("/x"), true);
check("503", robotsForStatus(503).agent("a").isAllowedPath("/x"), false);

console.log("ok");
