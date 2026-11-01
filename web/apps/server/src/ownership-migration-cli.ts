import { readFileSync } from "node:fs";
import { executeOwnershipCopy, inspectOwnershipCopy } from "./ownership-migration.js";

try {
  const [command, sourceDir, destinationDir, manifestPath, ...extra] = process.argv.slice(2);
  if (command === "inspect" && sourceDir && !destinationDir) {
    process.stdout.write(`${JSON.stringify(inspectOwnershipCopy({ sourceDir }), null, 2)}\n`);
  } else if (
    command === "apply" &&
    sourceDir &&
    destinationDir &&
    manifestPath &&
    extra.length === 0
  ) {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    process.stdout.write(
      `${JSON.stringify(await executeOwnershipCopy({ sourceDir, destinationDir, manifest }))}\n`,
    );
  } else
    throw new Error(
      "Usage: ownership-migration inspect SOURCE | apply SOURCE DESTINATION MANIFEST.json",
    );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Ownership copy failed"}\n`);
  process.exitCode = 1;
}
