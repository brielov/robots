/**
 * Downloads real robots.txt files into bench/corpus. The files belong to their
 * sites, so they're gitignored; run `bun run bench:corpus` to get them.
 */
import { mkdir } from "node:fs/promises";

const SITES = [
  "google.com",
  "youtube.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "reddit.com",
  "wikipedia.org",
  "amazon.com",
  "ebay.com",
  "walmart.com",
  "target.com",
  "bestbuy.com",
  "etsy.com",
  "alibaba.com",
  "aliexpress.com",
  "shopify.com",
  "apple.com",
  "microsoft.com",
  "github.com",
  "gitlab.com",
  "stackoverflow.com",
  "npmjs.com",
  "nytimes.com",
  "bbc.com",
  "cnn.com",
  "theguardian.com",
  "washingtonpost.com",
  "reuters.com",
  "forbes.com",
  "bloomberg.com",
  "wsj.com",
  "medium.com",
  "wordpress.com",
  "tumblr.com",
  "pinterest.com",
  "quora.com",
  "yelp.com",
  "tripadvisor.com",
  "booking.com",
  "airbnb.com",
  "expedia.com",
  "imdb.com",
  "netflix.com",
  "spotify.com",
  "twitch.tv",
  "vimeo.com",
  "dropbox.com",
  "adobe.com",
  "salesforce.com",
  "oracle.com",
  "ibm.com",
  "cloudflare.com",
  "mozilla.org",
  "archive.org",
  "craigslist.org",
  "indeed.com",
  "zillow.com",
  "weather.com",
  "cnet.com",
  "wired.com",
  "nih.gov",
  "whitehouse.gov",
  "nasa.gov",
  "bing.com",
  "yahoo.com",
  "duckduckgo.com",
  "baidu.com",
  "yandex.ru",
];

const directory = new URL("./corpus/", import.meta.url);
await mkdir(directory, { recursive: true });

const results = await Promise.allSettled(
  SITES.map(async (site) => {
    const response = await fetch(`https://${site}/robots.txt`, {
      headers: { "user-agent": "robots-bench/0.0 (library benchmark corpus)" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const head = new TextDecoder().decode(bytes.subarray(0, 512)).toLowerCase();
    if (head.includes("<html") || head.includes("<!doctype")) throw new Error("got HTML");
    await Bun.write(new URL(`${site}.txt`, directory), bytes);
    return bytes.length;
  }),
);

let saved = 0;
let total = 0;
results.forEach((result, index) => {
  if (result.status === "fulfilled") {
    saved++;
    total += result.value;
  } else {
    console.log(`skipped ${SITES[index]}: ${result.reason}`);
  }
});
console.log(`saved ${saved} of ${SITES.length} files, ${(total / 1024).toFixed(0)} KiB`);
