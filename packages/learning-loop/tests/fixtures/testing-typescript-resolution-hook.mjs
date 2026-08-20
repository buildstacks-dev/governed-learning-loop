// Plain Node executes this repository's TypeScript sources directly, but the
// checked-in NodeNext imports intentionally use their emitted `.js` names.
// Remap only missing relative `.js` imports inside this package's source tree.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const sourceRoot = new URL("../../src/", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        context.parentURL?.startsWith(sourceRoot.href) === true &&
        specifier.startsWith(".") &&
        specifier.endsWith(".js")
      ) {
        const typescriptTarget = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
        if (typescriptTarget.href.startsWith(sourceRoot.href) && existsSync(fileURLToPath(typescriptTarget))) {
          return nextResolve(typescriptTarget.href, context);
        }
      }
      throw error;
    }
  },
});
