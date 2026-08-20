// Bin entry (`pnpm --filter transcript-insights start -- <command> …`), run
// by plain `node` via native type stripping.
//
// Node strips types but never remaps `./x.js` specifiers onto `./x.ts`
// sources, and this workspace's dev-mode package exports point straight at
// TypeScript sources that use `.js` specifiers internally. The scoped resolve
// hook below retries a FAILED relative `.js` resolution as `.ts` — nothing
// more — so the whole graph loads under plain `node` with zero dependencies.
// It exists only because the entry runs from sources; a published dist ships
// real `.js` files and needs none of this. Registered before the dynamic
// import so the hook covers the entire module graph; tests bypass this file
// and import ./run.ts directly (vitest resolves `.js` specifiers itself).
import { registerHooks } from "node:module";

registerHooks({
  resolve: (specifier, context, nextResolve) => {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (!relative || !specifier.endsWith(".js")) throw error;
      try {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        throw error;
      }
    }
  },
});

const { runCli } = await import("./run.js");

process.exitCode = await runCli(process.argv.slice(2), {
  write: (line) => {
    process.stdout.write(`${line}\n`);
  },
});
