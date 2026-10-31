// Imports the built file directly, for a runtime that doesn't resolve a package
// by its own name.
import { parse } from "../../dist/index.js";

const bot = parse("user-agent: *\ndisallow: /private/\n").agent("MyBot");
if (bot.isAllowed("https://a.test/private/x")) throw new Error("expected disallowed");
if (!bot.isAllowed("https://a.test/public")) throw new Error("expected allowed");
console.log("ok");
