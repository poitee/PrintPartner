/**
 * Classify a print file from its bytes.
 *
 * Nothing here trusts a filename, a response content type, or an operator
 * checkbox: a `.3mf` extension says nothing about whether the container holds
 * printer instructions, and an operator who ticks "this is sliced" is guessing.
 * Every answer comes from the file signature and, for 3MF, from the ZIP central
 * directory.
 *
 * The 3MF path never decompresses anything and never parses XML, so there is no
 * XML external-entity, DTD, or outbound-fetch surface at all. Entry names in
 * the central directory are enough to tell a slicer project from bare geometry
 * from an embedded toolpath.
 */
import { createHash } from "node:crypto";
import type { PrintFileClassification, ThreeMfKind } from "@print-partner/contracts";

/** Bounds applied to a 3MF container before PrintPartner looks inside it. */
export const THREE_MF_ARCHIVE_LIMITS = {
  /** A real 3MF holds a model, some metadata, and thumbnails, not thousands of parts. */
  maxEntries: 2_000,
  maxEntryNameBytes: 1_024,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 256 * 1024 * 1024,
  /** Path segments below the package root. `3D/_rels/3dmodel.model.rels` is 3. */
  maxNestingDepth: 16,
} as const;

/**
 * Largest file PrintPartner will read into memory to classify and hash. Real
 * sliced artifacts are far smaller; anything past this is refused rather than
 * buffered.
 */
export const MAX_CLASSIFIABLE_BYTES = 256 * 1024 * 1024;

export type PrintFileRejectionReason =
  | "empty_file"
  | "file_too_large"
  | "unrecognized_signature"
  | "bgcode_header_invalid"
  | "archive_truncated"
  | "archive_entry_limit"
  | "archive_entry_too_large"
  | "archive_total_too_large"
  | "archive_nesting_limit"
  | "archive_unsafe_entry";

export type PrintFileClassificationResult =
  | {
      outcome: "classified";
      classification: PrintFileClassification;
      /** SHA-256 of exactly the bytes classified, per the artifact-hashing rule. */
      sha256: string;
      size_bytes: number;
    }
  | { outcome: "rejected"; reason: PrintFileRejectionReason };

/** Operator-facing wording for a rejection. */
export function printFileRejectionMessage(reason: PrintFileRejectionReason): string {
  switch (reason) {
    case "empty_file":
      return "That print file is empty";
    case "file_too_large":
      return "That print file is too large for PrintPartner to inspect";
    case "unrecognized_signature":
      return "Those bytes are not G-code, binary G-code, or a 3MF package";
    case "bgcode_header_invalid":
      return "That binary G-code file has a damaged header";
    case "archive_truncated":
      return "That 3MF package is truncated or is not a valid ZIP container";
    case "archive_entry_limit":
      return "That 3MF package holds too many entries to inspect safely";
    case "archive_entry_too_large":
      return "That 3MF package holds an entry too large to inspect safely";
    case "archive_total_too_large":
      return "That 3MF package unpacks to more data than PrintPartner will inspect";
    case "archive_nesting_limit":
      return "That 3MF package nests its entries too deeply to inspect safely";
    case "archive_unsafe_entry":
      return "That 3MF package holds an unsafe entry name";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

/**
 * What has to happen before a classification can be printed. Empty for a file
 * a printer can already execute.
 */
export function printFileNextAction(classification: PrintFileClassification): string {
  switch (classification.format) {
    case "gcode":
    case "bgcode":
      return "";
    case "3mf":
      switch (classification.kind) {
        case "toolpath_package":
          return "";
        case "slicer_project":
          return "That 3MF is a slicer project, so it needs slicing before a printer can run it";
        case "model_package":
          return "That 3MF holds only geometry, so it needs preparation and slicing";
        case "unsupported":
          return "PrintPartner cannot interpret that 3MF, so it can be downloaded but not printed";
        default: {
          const _exhaustive: never = classification.kind;
          return _exhaustive;
        }
      }
    default: {
      const _exhaustive: never = classification;
      return _exhaustive;
    }
  }
}

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_EOCD_LOCATOR = 0x07064b50;
const ZIP_EOCD_FIXED_BYTES = 22;
const ZIP_CENTRAL_HEADER_FIXED_BYTES = 46;
/** ZIP comment length is a uint16, so the EOCD starts within this window. */
const ZIP_EOCD_SEARCH_BYTES = ZIP_EOCD_FIXED_BYTES + 0xffff;

/** libbgcode file header magic, ASCII "GCDE". */
const BGCODE_MAGIC = 0x45444347;
/** Highest libbgcode container version PrintPartner recognizes. */
const BGCODE_MAX_VERSION = 1;
/** 0 = no checksum, 1 = CRC32. */
const BGCODE_MAX_CHECKSUM_TYPE = 1;
const BGCODE_HEADER_BYTES = 10;
const BGCODE_CRC32_BYTES = 4;
/** block type, compression, uncompressed size. */
const BGCODE_BLOCK_HEADER_BYTES = 8;
const BGCODE_COMPRESSED_SIZE_BYTES = 4;

/** Toolpath content: an entry a printer could execute directly. */
const TOOLPATH_ENTRY_SUFFIXES = [".gcode", ".gco", ".g", ".bgcode"] as const;

/** The OPC folder every slicer parks its own state in. */
const SLICER_STATE_PREFIX = "metadata/";

/**
 * Slicer state PrintPartner recognizes. PrusaSlicer writes
 * `Metadata/Slic3r_PE.config` and `Metadata/Slic3r_PE_model.config`; Bambu
 * Studio and OrcaSlicer write `Metadata/project_settings.config` and
 * `Metadata/model_settings.config`. All of them land here.
 */
const SLICER_STATE_SUFFIXES = [".config", ".ini"] as const;

/**
 * Reject the entry names an OPC package has no business carrying. Backslashes
 * are rejected rather than translated, so one archive cannot mean two different
 * paths on two different platforms.
 */
function entryNameIsUnsafe(entryName: string): boolean {
  if (!entryName) return true;
  if (entryName.includes("\0") || entryName.includes("\\")) return true;
  if (entryName.startsWith("/")) return true;
  if (/^[a-z]:/i.test(entryName)) return true;
  return entryName.split("/").some((segment) => segment === ".." || segment === ".");
}

type ThreeMfScan =
  | { outcome: "scanned"; kind: ThreeMfKind }
  | { outcome: "rejected"; reason: PrintFileRejectionReason };

/**
 * Walk the ZIP central directory and classify by entry name.
 *
 * Every cap is enforced from the central directory before a single byte is
 * inflated, which is what makes a zip bomb a rejection rather than an
 * out-of-memory. A ZIP64 archive that hides its real size behind the 0xFFFFFFFF
 * sentinel fails the per-entry cap on the sentinel itself, so an oversized
 * entry is refused whether or not its true size is recorded inline.
 */
function scanThreeMf(bytes: Uint8Array): ThreeMfScan {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdSearchStart = Math.max(0, bytes.byteLength - ZIP_EOCD_SEARCH_BYTES);
  let eocdOffset = -1;
  for (let offset = bytes.byteLength - ZIP_EOCD_FIXED_BYTES; offset >= eocdSearchStart; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_EOCD) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) return { outcome: "rejected", reason: "archive_truncated" };

  let entryCount = view.getUint16(eocdOffset + 10, true);
  let centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);

  // ZIP64: the classic fields saturate, and the real counts live in the ZIP64
  // record the locator points at.
  const locatorOffset = eocdOffset - 20;
  if (
    locatorOffset >= 0 &&
    view.getUint32(locatorOffset, true) === ZIP64_EOCD_LOCATOR &&
    (entryCount === 0xffff || centralDirectoryOffset === 0xffffffff)
  ) {
    const zip64Offset = Number(view.getBigUint64(locatorOffset + 8, true));
    if (
      !Number.isSafeInteger(zip64Offset) ||
      zip64Offset < 0 ||
      zip64Offset + 56 > bytes.byteLength ||
      view.getUint32(zip64Offset, true) !== ZIP64_EOCD
    ) {
      return { outcome: "rejected", reason: "archive_truncated" };
    }
    const zip64Entries = Number(view.getBigUint64(zip64Offset + 32, true));
    const zip64CentralOffset = Number(view.getBigUint64(zip64Offset + 48, true));
    if (!Number.isSafeInteger(zip64Entries) || !Number.isSafeInteger(zip64CentralOffset)) {
      return { outcome: "rejected", reason: "archive_truncated" };
    }
    if (zip64Entries > THREE_MF_ARCHIVE_LIMITS.maxEntries) {
      return { outcome: "rejected", reason: "archive_entry_limit" };
    }
    entryCount = zip64Entries;
    centralDirectoryOffset = zip64CentralOffset;
  }

  if (entryCount > THREE_MF_ARCHIVE_LIMITS.maxEntries) {
    return { outcome: "rejected", reason: "archive_entry_limit" };
  }
  if (centralDirectoryOffset < 0 || centralDirectoryOffset >= bytes.byteLength) {
    return { outcome: "rejected", reason: "archive_truncated" };
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let cursor = centralDirectoryOffset;
  let totalUncompressedBytes = 0;
  let sawModelPart = false;
  let sawSlicerState = false;
  let sawToolpath = false;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + ZIP_CENTRAL_HEADER_FIXED_BYTES > bytes.byteLength) {
      return { outcome: "rejected", reason: "archive_truncated" };
    }
    if (view.getUint32(cursor, true) !== ZIP_CENTRAL_HEADER) {
      return { outcome: "rejected", reason: "archive_truncated" };
    }
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const nameStart = cursor + ZIP_CENTRAL_HEADER_FIXED_BYTES;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.byteLength) {
      return { outcome: "rejected", reason: "archive_truncated" };
    }
    if (nameLength > THREE_MF_ARCHIVE_LIMITS.maxEntryNameBytes) {
      return { outcome: "rejected", reason: "archive_unsafe_entry" };
    }
    if (uncompressedSize > THREE_MF_ARCHIVE_LIMITS.maxEntryUncompressedBytes) {
      return { outcome: "rejected", reason: "archive_entry_too_large" };
    }
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > THREE_MF_ARCHIVE_LIMITS.maxTotalUncompressedBytes) {
      return { outcome: "rejected", reason: "archive_total_too_large" };
    }
    // High 16 bits of the external attributes hold the Unix mode. S_IFLNK is
    // 0xA000, so this is the symbolic-link-like entry the spec rules out.
    if (((externalAttributes >>> 16) & 0xf000) === 0xa000) {
      return { outcome: "rejected", reason: "archive_unsafe_entry" };
    }

    const rawName = decoder.decode(bytes.subarray(nameStart, nameEnd));
    const isDirectory = rawName.endsWith("/");
    const entryName = (isDirectory ? rawName.slice(0, -1) : rawName).toLowerCase();
    if (entryNameIsUnsafe(entryName)) {
      return { outcome: "rejected", reason: "archive_unsafe_entry" };
    }
    if (entryName.split("/").length > THREE_MF_ARCHIVE_LIMITS.maxNestingDepth) {
      return { outcome: "rejected", reason: "archive_nesting_limit" };
    }
    if (!isDirectory) {
      if (TOOLPATH_ENTRY_SUFFIXES.some((suffix) => entryName.endsWith(suffix))) sawToolpath = true;
      // `3D/3dmodel.model` is the payload part every real 3MF carries.
      if (entryName.startsWith("3d/") && entryName.endsWith(".model")) sawModelPart = true;
      if (
        entryName.startsWith(SLICER_STATE_PREFIX) &&
        SLICER_STATE_SUFFIXES.some((suffix) => entryName.endsWith(suffix))
      ) {
        sawSlicerState = true;
      }
    }

    cursor = nameEnd + extraLength + commentLength;
  }

  // Order matters: a sliced Bambu project carries both slicer settings and an
  // embedded toolpath, and the toolpath is the thing a printer can execute.
  if (sawToolpath) return { outcome: "scanned", kind: "toolpath_package" };
  if (sawModelPart && sawSlicerState) return { outcome: "scanned", kind: "slicer_project" };
  if (sawModelPart) return { outcome: "scanned", kind: "model_package" };
  return { outcome: "scanned", kind: "unsupported" };
}

/**
 * Structural validation of a libbgcode container: magic, version, checksum
 * type, and a block chain whose declared sizes stay inside the file.
 *
 * This deliberately stops short of decoding block payloads. libbgcode is
 * AGPL-3.0 and PrintPartner has not completed that license review, so a
 * validated file is stored and hashed rather than parsed.
 */
function bgcodeHeaderIsValid(bytes: Uint8Array): boolean {
  if (bytes.byteLength < BGCODE_HEADER_BYTES) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  const checksumType = view.getUint16(8, true);
  if (version === 0 || version > BGCODE_MAX_VERSION) return false;
  if (checksumType > BGCODE_MAX_CHECKSUM_TYPE) return false;

  const checksumBytes = checksumType === 0 ? 0 : BGCODE_CRC32_BYTES;
  let cursor = BGCODE_HEADER_BYTES;
  let blocks = 0;
  while (cursor < bytes.byteLength) {
    if (cursor + BGCODE_BLOCK_HEADER_BYTES > bytes.byteLength) return false;
    const compression = view.getUint16(cursor + 2, true);
    const uncompressedSize = view.getUint32(cursor + 4, true);
    let payloadStart = cursor + BGCODE_BLOCK_HEADER_BYTES;
    let payloadSize = uncompressedSize;
    if (compression !== 0) {
      if (payloadStart + BGCODE_COMPRESSED_SIZE_BYTES > bytes.byteLength) return false;
      payloadSize = view.getUint32(payloadStart, true);
      payloadStart += BGCODE_COMPRESSED_SIZE_BYTES;
    }
    const next = payloadStart + payloadSize + checksumBytes;
    if (next <= cursor || next > bytes.byteLength) return false;
    cursor = next;
    blocks += 1;
  }
  // A container with a header and no blocks carries no print instructions.
  return blocks > 0;
}

/**
 * Structural validation of ASCII G-code: text with at least one executable
 * command. Slicer headers can run to hundreds of kilobytes of comments and
 * base64 thumbnails, so this scans the whole buffer rather than a prefix that
 * would misjudge a real file.
 */
function gcodeBodyIsValid(bytes: Uint8Array): boolean {
  let sawCommand = false;
  let atLineStart = true;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index]!;
    if (byte === 0) return false;
    if (byte === 0x0a || byte === 0x0d) {
      atLineStart = true;
      continue;
    }
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) return false;
    if (atLineStart) {
      atLineStart = byte === 0x20 || byte === 0x09;
      // A command line opens with G, M, or T followed by its number.
      if (
        !sawCommand &&
        (byte === 0x47 || byte === 0x4d || byte === 0x54 || byte === 0x67 || byte === 0x6d || byte === 0x74)
      ) {
        const next = bytes[index + 1];
        if (next !== undefined && next >= 0x30 && next <= 0x39) sawCommand = true;
      }
    }
  }
  return sawCommand;
}

/**
 * Classify print-file bytes and hash them in the same pass.
 *
 * The returned classification is the only thing that decides whether a file is
 * print-ready. Callers must not accept a client-supplied classification.
 */
export function classifyPrintFileBytes(bytes: Uint8Array): PrintFileClassificationResult {
  if (bytes.byteLength === 0) return { outcome: "rejected", reason: "empty_file" };
  if (bytes.byteLength > MAX_CLASSIFIABLE_BYTES) {
    return { outcome: "rejected", reason: "file_too_large" };
  }

  const identity = {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size_bytes: bytes.byteLength,
  };

  if (bytes.byteLength >= 4) {
    const signature = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      0,
      true,
    );
    if (signature === ZIP_LOCAL_HEADER) {
      const scan = scanThreeMf(bytes);
      if (scan.outcome === "rejected") return scan;
      return {
        outcome: "classified",
        classification: { format: "3mf", kind: scan.kind },
        ...identity,
      };
    }
    if (signature === BGCODE_MAGIC) {
      if (!bgcodeHeaderIsValid(bytes)) {
        return { outcome: "rejected", reason: "bgcode_header_invalid" };
      }
      return { outcome: "classified", classification: { format: "bgcode" }, ...identity };
    }
  }

  if (gcodeBodyIsValid(bytes)) {
    return { outcome: "classified", classification: { format: "gcode" }, ...identity };
  }
  return { outcome: "rejected", reason: "unrecognized_signature" };
}
