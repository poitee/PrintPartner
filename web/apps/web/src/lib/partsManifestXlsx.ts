/**
 * Minimal .xlsx encode/decode for the parts manifest using JSZip (already in the
 * monorepo). Writer uses inline strings; reader supports sharedStrings + inlineStr
 * + numeric cells so Excel / Google Sheets exports round-trip.
 */

import JSZip from "jszip";
import {
  PARTS_MANIFEST_HEADERS,
  neutralizeFormulaPrefix,
  parseManifestTable,
  type ManifestParseIssue,
  type PartsManifestRow,
} from "./partsManifest";

function colLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Strip characters outside the XML 1.0 Char production (keep tab/LF/CR). */
function stripXmlIllegalControls(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    const valid =
      code === 0x9 ||
      code === 0xa ||
      code === 0xd ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff);
    if (valid) out += char;
  }
  return out;
}

function xmlEscape(value: string): string {
  return stripXmlIllegalControls(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sheetXml(rows: PartsManifestRow[]): string {
  const matrix = [PARTS_MANIFEST_HEADERS as unknown as string[], ...rows.map((r) =>
    PARTS_MANIFEST_HEADERS.map((h) => r[h] ?? ""),
  )];
  const rowXml = matrix
    .map((cells, rIdx) => {
      const cXml = cells
        .map((val, cIdx) => {
          const ref = `${colLetter(cIdx)}${rIdx + 1}`;
          // Header row has no formula-prefix risk; data rows get the same
          // formula-injection guard as the CSV export path.
          const safe = rIdx === 0 ? val : neutralizeFormulaPrefix(val);
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(safe)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rIdx + 1}">${cXml}</row>`;
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rowXml}</sheetData></worksheet>`
  );
}

export async function partsManifestToXlsxBlob(rows: PartsManifestRow[]): Promise<Blob> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `</Types>`,
  );
  zip.folder("_rels")!.file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
  );
  const xl = zip.folder("xl")!;
  xl.file(
    "workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="Parts" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  xl.folder("_rels")!.file(
    "workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `</Relationships>`,
  );
  xl.folder("worksheets")!.file("sheet1.xml", sheetXml(rows));

  const buf = await zip.generateAsync({ type: "arraybuffer" });
  return new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/** Decode a handful of XML entities used in OOXML cell text (single pass). */
function decodeXml(value: string): string {
  return value.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|lt|gt|quot|apos|amp);/g, (match, hex, dec) => {
    if (hex != null || dec != null) {
      const code = Number.parseInt(hex != null ? hex : dec, hex != null ? 16 : 10);
      if (
        !Number.isFinite(code) ||
        code < 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        return match;
      }
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    switch (match) {
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&apos;":
        return "'";
      case "&amp;":
        return "&";
      default:
        return match;
    }
  });
}

function parseSharedStrings(xml: string): string[] {
  // Avoid DOMParser so Node/vitest and browsers share one path.
  const items = [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)];
  return items.map((m) => {
    const inner = m[1] ?? "";
    const texts = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)];
    return texts.map((t) => decodeXml(t[1] ?? "")).join("");
  });
}

function cellRefCol(ref: string): number {
  const m = /^([A-Z]+)/i.exec(ref);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]!.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

function cellValue(cellXml: string, shared: string[]): string {
  const tMatch = /\bt="([^"]+)"/.exec(cellXml);
  const t = tMatch?.[1];
  if (t === "s") {
    const v = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(cellXml)?.[1] ?? "";
    return shared[Number(v)] ?? "";
  }
  if (t === "inlineStr") {
    const texts = [...cellXml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)];
    return texts.map((x) => decodeXml(x[1] ?? "")).join("");
  }
  if (t === "b") {
    const v = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(cellXml)?.[1] ?? "";
    return v.trim() === "1" ? "true" : "false";
  }
  const v = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(cellXml)?.[1];
  if (v != null) return decodeXml(v);
  const inline = /<t\b[^>]*>([\s\S]*?)<\/t>/i.exec(cellXml)?.[1];
  return inline != null ? decodeXml(inline) : "";
}

function readSheetMatrix(sheetXmlText: string, shared: string[]): string[][] {
  const rows = [...sheetXmlText.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)];
  const matrix: string[][] = [];
  for (const rowMatch of rows) {
    const rowInner = rowMatch[1] ?? "";
    // Self-closing `<c …/>` must come first: otherwise `[^>]*` can consume the `/`
    // and the non-greedy body then swallows later cells until the next `</c>`.
    const cells = [...rowInner.matchAll(/<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/gi)];
    const line: string[] = [];
    for (const cellMatch of cells) {
      const attrs = cellMatch[1] ?? cellMatch[2] ?? "";
      const body = cellMatch[3] ?? "";
      const ref = /\br="([^"]+)"/.exec(attrs)?.[1] ?? "";
      const col = cellRefCol(ref);
      while (line.length < col) line.push("");
      line[col] = cellValue(`<c ${attrs}>${body}</c>`, shared);
    }
    matrix.push(line);
  }
  return matrix;
}

export async function parsePartsManifestXlsx(data: ArrayBuffer): Promise<{
  rows: PartsManifestRow[];
  errors: ManifestParseIssue[];
}> {
  const zip = await JSZip.loadAsync(data);
  const sheetEntry =
    zip.file("xl/worksheets/sheet1.xml") ??
    Object.values(zip.files).find((f) => /xl\/worksheets\/sheet\d+\.xml$/i.test(f.name) && !f.dir);
  if (!sheetEntry) {
    return { rows: [], errors: [{ row: 0, message: "No worksheet found in workbook" }] };
  }
  const sharedFile = zip.file("xl/sharedStrings.xml");
  const shared = sharedFile ? parseSharedStrings(await sharedFile.async("string")) : [];
  const sheetText = await sheetEntry.async("string");
  const matrix = readSheetMatrix(sheetText, shared);
  return parseManifestTable(matrix);
}
