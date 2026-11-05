// A small, bounded ZIP reader. Reads the central directory without inflating anything (so declared
// sizes can be checked first), then inflates one entry at a time through fflate's streaming
// Inflate with a hard cap on the *actual* output, whatever the archive claims.

import { Inflate } from "fflate";

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number; // declared uncompressed size (attacker-supplied)
  localOffset: number;
  isDir: boolean;
}

export class ZipError extends Error {}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Parse the central directory. Throws ZipError on anything malformed, ZIP64, or over `maxEntries`. */
export function readCentralDirectory(buf: Uint8Array, maxEntries: number): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (u32(buf, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a zip file");
  const count = u16(buf, eocd + 10);
  const cdSize = u32(buf, eocd + 12);
  const cdOffset = u32(buf, eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError("ZIP64 archives aren't supported");
  if (count > maxEntries) throw new ZipError(`more than ${maxEntries} files`);
  if (cdOffset + cdSize > buf.length) throw new ZipError("truncated zip");
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || u32(buf, p) !== 0x02014b50) throw new ZipError("corrupt central directory");
    const method = u16(buf, p + 10);
    const compressedSize = u32(buf, p + 20);
    const size = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const localOffset = u32(buf, p + 42);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError("ZIP64 archives aren't supported");
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compressedSize, size, localOffset, isDir: name.endsWith("/") });
    p += 46 + nameLen + extraLen + commentLen;
  }
  checkNoOverlap(buf, entries);
  return entries;
}

class OutputLimit extends Error {}

/**
 * Compressed bytes handed to the inflater per push. fflate inflates a whole push before calling
 * back, so the push size is what bounds a single allocation: DEFLATE expands at most ~1032x
 * (a 258-byte match in 2 bits), so one push yields at most INFLATE_SLICE * 1032 + 258 bytes, on top
 * of the 32 KiB window fflate keeps (its buffer at most doubles that).
 */
export const INFLATE_SLICE = 256;
export const MAX_PUSH_OUTPUT = INFLATE_SLICE * 1032 + 258;

/** Total inflation work for one archive: every byte inflated counts (peeks and rejects too). */
export class WorkMeter {
  used = 0;
  maxChunk = 0;
  constructor(readonly limit: number) {}
  charge(n: number) {
    this.used += n;
    if (n > this.maxChunk) this.maxChunk = n;
    if (this.used > this.limit) throw new ZipError("this zip expands to more than allowed");
  }
}

/**
 * Inflate one entry, producing at most `maxOut` bytes, in INFLATE_SLICE pushes, every produced
 * byte charged to `meter`. With `truncate`, stop at the limit and return the prefix (a peek);
 * otherwise exceeding it throws ZipError, which callers treat as fatal for the whole archive.
 */
export function inflateEntry(buf: Uint8Array, e: ZipEntry, maxOut: number, meter: WorkMeter, truncate = false): Uint8Array {
  const start = dataStart(buf, e);
  const data = buf.subarray(start, start + e.compressedSize);
  if (data.length !== e.compressedSize) throw new ZipError(`truncated entry ${e.name}`);
  if (e.method === 0) {
    const n = Math.min(data.length, truncate ? maxOut : data.length);
    if (n > maxOut) throw new ZipError(`${e.name} is larger than it claims`);
    meter.charge(n);
    return data.slice(0, n);
  }
  if (e.method !== 8) throw new ZipError(`${e.name}: unsupported compression`);
  const chunks: Uint8Array[] = [];
  let out = 0;
  let full = false;
  const inf = new Inflate((chunk) => {
    meter.charge(chunk.length);
    const room = maxOut - out;
    if (chunk.length > room) {
      if (truncate && room > 0) chunks.push(chunk.slice(0, room));
      out = maxOut;
      full = true;
      throw new OutputLimit();
    }
    chunks.push(chunk.slice());
    out += chunk.length;
  });
  try {
    if (!data.length) inf.push(new Uint8Array(0), true);
    for (let i = 0; i < data.length && !full; i += INFLATE_SLICE) {
      inf.push(data.subarray(i, Math.min(i + INFLATE_SLICE, data.length)), i + INFLATE_SLICE >= data.length);
    }
  } catch (err) {
    if (err instanceof ZipError) throw err;
    if (!(err instanceof OutputLimit)) throw new ZipError(`${e.name}: ${(err as Error).message}`);
    if (!truncate) throw new ZipError(`${e.name} is larger than it claims`);
  }
  const res = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    res.set(c, o);
    o += c.length;
  }
  return res;
}

function dataStart(buf: Uint8Array, e: ZipEntry): number {
  const lh = e.localOffset;
  if (lh + 30 > buf.length || u32(buf, lh) !== 0x04034b50) throw new ZipError(`corrupt entry ${e.name}`);
  return lh + 30 + u16(buf, lh + 26) + u16(buf, lh + 28);
}

/** Refuse archives whose entries share or overlap their data (central-directory aliasing). */
export function checkNoOverlap(buf: Uint8Array, entries: ZipEntry[]) {
  const spans = entries.map((e) => ({ name: e.name, from: e.localOffset, to: dataStart(buf, e) + e.compressedSize })).sort((a, b) => a.from - b.from);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].from < spans[i - 1].to) throw new ZipError(`entries ${spans[i - 1].name} and ${spans[i].name} overlap`);
  }
  if (spans.length && spans[spans.length - 1].to > buf.length) throw new ZipError("truncated zip");
}
