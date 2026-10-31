/** Builds dist/: one bundled module, plus type declarations from tsc. */
import { Glob } from "bun";

await Bun.$`rm -rf dist`;

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "browser",
  format: "esm",
  minify: true,
});
if (!result.success) throw new AggregateError(result.logs, "Build failed");

await Bun.$`tsc -p tsconfig.build.json`;

// Nothing public refers to these.
await Bun.$`rm dist/canonical.d.ts dist/match.d.ts dist/url.d.ts`;

// Source imports use .ts, which consumers' compilers won't accept by default.
for await (const path of new Glob("dist/*.d.ts").scan()) {
  const text = await Bun.file(path).text();
  await Bun.write(path, text.replace(/(from "\.\/[^"]+)\.ts"/g, '$1.js"'));
}
