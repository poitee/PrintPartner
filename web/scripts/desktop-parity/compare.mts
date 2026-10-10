import { readFileSync } from "node:fs";
import { compare, json } from "./model.mjs";

const [left, right] = process.argv.slice(2);
if (!left || !right) throw new Error("Usage: node --conditions=development --import tsx scripts/desktop-parity/compare.mts LEFT.json RIGHT.json");
compare(json(JSON.parse(readFileSync(left, "utf8"))), json(JSON.parse(readFileSync(right, "utf8"))));
process.stdout.write("PASS: exact normalized autosave corpus match\n");
