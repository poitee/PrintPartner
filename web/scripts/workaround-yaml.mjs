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
        // Source tokens preserve physical lines even for folded/chomped scalars,
        // and exclude block headers, trailing comments, and adjacent YAML keys.
        const source = value.srcToken?.type === "block-scalar"
          ? value.srcToken.source
          : text.slice(value.range[0], value.range[1]);
        lines.push(...source.split("\n"));
      },
    });
  }
  return lines;
}
