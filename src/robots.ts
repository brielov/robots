import { canonicalPath } from "./canonical.ts";
import { compileRules, type CompiledRules, isPathAllowed } from "./match.ts";
import {
  collectRules,
  GLOBAL_AGENT,
  type ParsedFile,
  type ParseOptions,
  parseFile,
} from "./parse.ts";
import { canonicalRequestPath } from "./url.ts";

const NO_GROUPS: readonly number[] = [];

/** The rules that apply to one user agent. Get one from {@link Robots.agent}. */
export class Agent {
  readonly #file: ParsedFile;
  readonly #groups: readonly number[];
  #rules: CompiledRules | undefined;

  /** @internal */
  constructor(file: ParsedFile, groups: readonly number[]) {
    this.#file = file;
    this.#groups = groups;
  }

  /** The largest `Crawl-delay` in this agent's groups, in seconds, if any. */
  get crawlDelay(): number | undefined {
    let delay: number | undefined;
    for (const id of this.#groups) {
      const candidate = this.#file.groups[id]?.crawlDelay;
      if (candidate !== undefined && (delay === undefined || candidate > delay)) delay = candidate;
    }
    return delay;
  }

  /**
   * Whether this agent may fetch a URL. The scheme may be left out, as in
   * `example.com/a`. A string that can't be a URL is read as leniently as
   * possible instead of throwing, and has the path `/` if nothing else fits.
   */
  isAllowed(url: string | URL): boolean {
    // `href`, not `pathname + search`: `search` loses the `?` of an empty query.
    return this.#decide(canonicalRequestPath(typeof url === "string" ? url : url.href));
  }

  /**
   * Whether this agent may fetch a path, which may include a query. Prefer this
   * over {@link isAllowed} when you already have the path.
   */
  isAllowedPath(path: string): boolean {
    return this.#decide(canonicalPath(path));
  }

  #decide(canonical: string): boolean {
    this.#rules ??= compileRules(collectRules(this.#file, this.#groups));
    return isPathAllowed(this.#rules, canonical);
  }
}

/** A parsed robots.txt file. Create one with {@link parse}. */
export class Robots {
  /** The `Sitemap` URLs in the file, in order. They apply to every agent. */
  readonly sitemaps: readonly string[];

  readonly #file: ParsedFile;
  readonly #agents = new Map<string, Agent>();
  #fallback: Agent | undefined;

  /** @internal */
  constructor(file: ParsedFile) {
    this.#file = file;
    this.sitemaps = file.sitemaps;
  }

  /**
   * Returns the rules for a crawler's product token, such as `"Googlebot"`.
   * Compare the full token, not a whole `User-Agent` header: a name that
   * matches no group gets the `*` group, and if there is none, no rules apply.
   *
   * Agents are compiled on first use and cached, so hold on to the result
   * instead of calling this for every URL.
   */
  agent(name: string): Agent {
    const token = name.toLowerCase();
    const groups = this.#file.agents.get(token);
    if (groups === undefined) {
      this.#fallback ??= new Agent(this.#file, this.#file.agents.get(GLOBAL_AGENT) ?? NO_GROUPS);
      return this.#fallback;
    }
    let agent = this.#agents.get(token);
    if (agent === undefined) {
      agent = new Agent(this.#file, groups);
      this.#agents.set(token, agent);
    }
    return agent;
  }
}

/**
 * Parses a robots.txt file. File content never makes this throw: lines that
 * can't be understood are ignored. It throws a `RangeError` if `maxBytes` is
 * negative or `NaN`.
 */
export function parse(input: string | Uint8Array, options?: ParseOptions): Robots {
  return new Robots(parseFile(input, options));
}

/**
 * Returns the policy for a fetch that produced no usable file, following
 * RFC 9309 section 2.3.1. A status of 400 to 499 means the file is unavailable,
 * so everything is allowed. 429 is the exception: being rate limited says
 * nothing about the file, so it counts as a server error, like every other
 * status here, and everything is disallowed.
 *
 * Use this for failed fetches only. A successful response should go to
 * {@link parse}.
 */
export function robotsForStatus(status: number): Robots {
  const unavailable = status >= 400 && status <= 499 && status !== 429;
  return parse(unavailable ? "" : "user-agent: *\ndisallow: /\n");
}
