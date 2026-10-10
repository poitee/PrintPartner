import { isAlias, isScalar, parseAllDocuments, visit } from "yaml";

export function yamlRunLines(text) {
  const lines = [];
  const documents = parseAllDocuments(text, { keepSourceTokens: true });
  // Malformed YAML still gets a conservative count, without parsing shell text.
  if (documents.some((document) => document.errors.length > 0)) return text.split("\n");
  for (const document of documents) {
    visit(document, {
      Pair(_key, pair) {
        if (!isScalar(pair.key) || pair.key.value !== "run") return;
        const value = isAlias(pair.value) ? pair.value.resolve(document) : pair.value;
        if (!isScalar(value) || typeof value.value !== "string" || !value.range) return;
        // Block tokens exclude their YAML header and preserve physical lines.
        // Inline commands include their whole run line, including YAML comments.
        let source = value.srcToken?.type === "block-scalar"
          ? value.srcToken.source
          : text.slice(value.range[0], value.range[1]);
        const keyStart = pair.key.range[0];
        const lineStart = text.lastIndexOf("\n", keyStart - 1) + 1;
        const newline = text.indexOf("\n", keyStart);
        const lineEnd = newline === -1 ? text.length : newline;
        if (isAlias(pair.value)) lines.push(text.slice(lineStart, lineEnd));
        if (value.srcToken?.type !== "block-scalar" &&
            value.range[0] >= keyStart && value.range[0] < lineEnd) {
          const end = text.indexOf("\n", value.range[1]);
          source = text.slice(lineStart, end === -1 ? text.length : end);
        }
        lines.push(...source.split("\n"));
      },
    });
  }
  return lines;
}
