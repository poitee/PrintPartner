import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checklistFixtureNames,
  exportHtmlFixtureRoot,
  readChecklistFixture,
  renderChecklistFixture,
} from "../apps/server/src/test/export-html-golden.js";

if (process.argv.slice(2).join(" ") !== "--write") {
  throw new Error("Use --write to explicitly regenerate goldens; Vitest checks without writing.");
}
for (const name of checklistFixtureNames()) {
  const rendered = renderChecklistFixture(readChecklistFixture(name));
  const output = name.replace(/\.json$/, ".html");
  writeFileSync(join(exportHtmlFixtureRoot, "expected", output), rendered.html);
  console.log(`${output}: ${rendered.partCount} parts, ${rendered.thumbCount} thumbnails`);
}
