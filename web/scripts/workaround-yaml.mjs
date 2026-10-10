import { isAlias, isScalar, LineCounter, parseAllDocuments, visit } from "yaml";

export function yamlRunLines(text) {
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(text, { lineCounter });
  // Malformed YAML still gets a conservative count, without parsing shell text.
  if (documents.some((document) => document.errors.length > 0)) return text.split("\n");
  const selected = new Set();
  const flowFields = [];
  const aliasValues = [];
  const selectLines = (start, end) => {
    const first = lineCounter.linePos(start).line - 1;
    const last = lineCounter.linePos(Math.max(start, end - 1)).line - 1;
    for (let line = first; line <= last; line += 1) selected.add(line);
  };
  for (const document of documents) {
    visit(document, {
      Pair(_key, pair, path) {
        if (!isScalar(pair.key) || pair.key.value !== "run") {
          if (path.at(-1)?.flow && pair.key?.range && pair.value?.range) {
            flowFields.push([pair.key.range[0], pair.value.range[1]]);
          }
          return;
        }
        const value = isAlias(pair.value) ? pair.value.resolve(document) : pair.value;
        if (!isScalar(value) || typeof value.value !== "string" || !value.range) return;
        // Select complete physical lines, including key-line and end-line comments.
        selectLines(pair.key.range[0], pair.value.range[1]);
        if (isAlias(pair.value)) {
          selectLines(value.range[0], value.range[1]);
          aliasValues.push([value.range[0], value.range[1]]);
        }
      },
    });
  }
  const physicalLines = text.split("\n");
  return [...selected].sort((a, b) => a - b).map((line) => {
    // Flow mappings can put unrelated fields on a selected run line. Mask only
    // those fields, retaining comments and scalar content referenced by aliases.
    const offset = lineCounter.lineStarts[line];
    return physicalLines[line].split("").map((char, column) => {
      const index = offset + column;
      const contains = ([start, end]) => index >= start && index < end;
      return flowFields.some(contains) && !aliasValues.some(contains) ? " " : char;
    }).join("");
  });
}
