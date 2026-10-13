import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { strFromU8 } from "fflate";

export class InvalidSourceArchiveError extends Error {
  constructor() {
    super("File is not a valid ZIP archive or is truncated");
    this.name = "InvalidSourceArchiveError";
  }
}

type ZipEntry = {
  name: string;
  size: number;
  crc: number;
};

export function readZipDirectory(path: string, maxEntries: number): ZipEntry[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const read = (offset: number, length: number): Buffer => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > size) {
        throw new InvalidSourceArchiveError();
      }
      const bytes = Buffer.alloc(length);
      if (readSync(fd, bytes, 0, length, offset) !== length) throw new InvalidSourceArchiveError();
      return bytes;
    };
    const uint64 = (bytes: Buffer, offset: number): number => {
      if (offset + 8 > bytes.length) throw new InvalidSourceArchiveError();
      const value = Number(bytes.readBigUInt64LE(offset));
      if (!Number.isSafeInteger(value)) throw new InvalidSourceArchiveError();
      return value;
    };
    const tailOffset = Math.max(0, size - 65557);
    const tail = read(tailOffset, size - tailOffset);
    let end = tail.length - 22;
    for (; end >= 0; end--) {
      if (tail.readUInt32LE(end) === 0x06054b50 && end + 22 + tail.readUInt16LE(end + 20) === tail.length) break;
    }
    if (end < 0) throw new InvalidSourceArchiveError();
    if (tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0) throw new InvalidSourceArchiveError();
    let count = tail.readUInt16LE(end + 10);
    let directorySize = tail.readUInt32LE(end + 12);
    let offset = tail.readUInt32LE(end + 16);
    let directoryEnd = tailOffset + end;
    if (count === 0xffff || directorySize === 0xffffffff || offset === 0xffffffff) {
      const locatorOffset = directoryEnd - 20;
      const locator = read(locatorOffset, 20);
      if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) throw new InvalidSourceArchiveError();
      directoryEnd = uint64(locator, 8);
      const zip64 = read(directoryEnd, 56);
      if (zip64.readUInt32LE(0) !== 0x06064b50 || zip64.readUInt32LE(16) !== 0 || zip64.readUInt32LE(20) !== 0) throw new InvalidSourceArchiveError();
      const recordSize = uint64(zip64, 4);
      if (recordSize < 44 || directoryEnd + 12 + recordSize !== locatorOffset) throw new InvalidSourceArchiveError();
      count = uint64(zip64, 32);
      if (uint64(zip64, 24) !== count) throw new InvalidSourceArchiveError();
      directorySize = uint64(zip64, 40);
      offset = uint64(zip64, 48);
    } else if (tail.readUInt16LE(end + 8) !== count) {
      throw new InvalidSourceArchiveError();
    }
    if (count > maxEntries) throw new Error(`Archive has too many entries (${count}, max ${maxEntries})`);
    if (offset + directorySize !== directoryEnd) throw new InvalidSourceArchiveError();
    const directoryStart = offset;
    const entries: ZipEntry[] = [];
    const names = new Set<string>();
    for (let index = 0; index < count; index++) {
      const header = read(offset, 46);
      if (header.readUInt32LE(0) !== 0x02014b50 || header.readUInt16LE(34) !== 0) throw new InvalidSourceArchiveError();
      const flags = header.readUInt16LE(8);
      if (flags & 1) throw new Error("Encrypted ZIP archives are not supported");
      const nameLength = header.readUInt16LE(28);
      const extraLength = header.readUInt16LE(30);
      const nameBytes = read(offset + 46, nameLength);
      const name = strFromU8(nameBytes, !(flags & 0x800));
      if (names.has(name)) throw new Error(`Archive has duplicate entry: ${name}`);
      names.add(name);
      let uncompressed = header.readUInt32LE(24);
      let compressed = header.readUInt32LE(20);
      let localOffset = header.readUInt32LE(42);
      if ([uncompressed, compressed, localOffset].includes(0xffffffff)) {
        const extra = read(offset + 46 + nameLength, extraLength);
        let pos = 0;
        while (pos + 4 <= extra.length && extra.readUInt16LE(pos) !== 1) pos += 4 + extra.readUInt16LE(pos + 2);
        if (pos + 4 > extra.length) throw new InvalidSourceArchiveError();
        const zip64 = extra.subarray(pos + 4, pos + 4 + extra.readUInt16LE(pos + 2));
        let field = 0;
        if (uncompressed === 0xffffffff) { uncompressed = uint64(zip64, field); field += 8; }
        if (compressed === 0xffffffff) { compressed = uint64(zip64, field); field += 8; }
        if (localOffset === 0xffffffff) localOffset = uint64(zip64, field);
      }
      const local = read(localOffset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== header.readUInt16LE(10)) throw new InvalidSourceArchiveError();
      const localName = read(localOffset + 30, local.readUInt16LE(26));
      if (!localName.equals(nameBytes) || localOffset + 30 + localName.length + local.readUInt16LE(28) + compressed > directoryStart) throw new InvalidSourceArchiveError();
      entries.push({ name, size: uncompressed, crc: header.readUInt32LE(16) });
      offset += 46 + nameLength + extraLength + header.readUInt16LE(32);
      if (offset > directoryEnd) throw new InvalidSourceArchiveError();
    }
    if (offset !== directoryEnd) throw new InvalidSourceArchiveError();
    return entries;
  } finally {
    closeSync(fd);
  }
}
