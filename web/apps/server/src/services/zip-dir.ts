import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { zipSync } from "fflate";

/**
 * Zip every file under `dir` into `outZipPath`, preserving relative paths.
 * Returns the number of files written. Used to turn the STL-pack export
 * directory into a single browser-downloadable archive.
 */
export function zipDirectoryToFile(dir: string, outZipPath: string): number {
  const files: Record<string, Uint8Array> = {};
  let count = 0;

  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        const rel = relative(dir, full).split(sep).join("/");
        files[rel] = new Uint8Array(readFileSync(full));
        count += 1;
      }
    }
  };

  walk(dir);
  const zipped = zipSync(files, { level: 6 });
  writeFileSync(outZipPath, zipped);
  return count;
}
