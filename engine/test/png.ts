/**
 * A minimal PNG reader and writer for the tests (node's zlib, no package):
 * 8-bit greyscale, RGB, RGBA and palette images, not interlaced — what PIL
 * writes for the exported layers and the style atlas. The writer always
 * writes RGBA, for the debug pictures under build/engine-test.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function readPng(path: string): Rgba {
  const buf = readFileSync(path);
  let pos = 8;
  let width = 0, height = 0, depth = 0, type = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      type = body[9];
      if (body[12] !== 0) throw new Error(`${path}: interlaced PNG`);
    } else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') trns = body;
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error(`${path}: bit depth ${depth}`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type as 0 | 2 | 3 | 4 | 6];
  if (!channels) throw new Error(`${path}: colour type ${type}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? rows[y * stride + i - channels] : 0;
      const b = y > 0 ? rows[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= channels ? rows[(y - 1) * stride + i - channels] : 0;
      let v = src[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      rows[y * stride + i] = v & 0xff;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const s = p * channels;
    let r = 0, g = 0, b = 0, al = 255;
    if (type === 0) r = g = b = rows[s];
    else if (type === 4) { r = g = b = rows[s]; al = rows[s + 1]; }
    else if (type === 2) { r = rows[s]; g = rows[s + 1]; b = rows[s + 2]; }
    else if (type === 6) { r = rows[s]; g = rows[s + 1]; b = rows[s + 2]; al = rows[s + 3]; }
    else {
      const k = rows[s];
      r = palette![k * 3]; g = palette![k * 3 + 1]; b = palette![k * 3 + 2];
      al = trns && k < trns.length ? trns[k] : 255;
    }
    data.set([r, g, b, al], p * 4);
  }
  return { width, height, data };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const v of b) c = CRC[(c ^ v) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(kind: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const kb = Buffer.from(kind, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([kb, body])));
  return Buffer.concat([len, kb, body, crc]);
}

export function writePng(path: string, img: Rgba): void {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(img.height * (img.width * 4 + 1));
  for (let y = 0; y < img.height; y++) {
    raw[y * (img.width * 4 + 1)] = 0;
    Buffer.from(img.data.buffer, img.data.byteOffset + y * img.width * 4, img.width * 4)
      .copy(raw, y * (img.width * 4 + 1) + 1);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  writeFileSync(path, Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
