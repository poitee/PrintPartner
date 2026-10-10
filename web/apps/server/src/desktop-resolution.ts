import { realpathSync } from "node:fs";
import { isBuiltin, registerHooks } from "node:module";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const prefix = "--pp-desktop-package-root=";
const argument = process.argv[2];
if (!argument?.startsWith(prefix) || !isAbsolute(argument.slice(prefix.length))) {
  throw new Error("Desktop package boundary missing");
}
const root = realpathSync(argument.slice(prefix.length));

function admit(url: string): void {
  if (isBuiltin(url)) return;
  if (!url.startsWith("file:")) throw new Error("Desktop code URL denied");
  const target = realpathSync(fileURLToPath(url));
  const path = relative(root, target);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error("Desktop code escaped package boundary");
  }
}

admit(import.meta.url);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    admit(result.url);
    return result;
  },
  load(url, context, nextLoad) {
    admit(url);
    return nextLoad(url, context);
  },
});
