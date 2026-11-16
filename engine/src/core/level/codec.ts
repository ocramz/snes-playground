/**
 * A level in a URL (docs/editor.md "The URL"). The page's hash carries it:
 *
 *   #l=<payload>        play the level (what Share copies)
 *   #l=<payload>&edit   the editor on it (the editor's own working URL)
 *   (no l=)             the editor on the default level
 *
 * The payload, version 1, is base64url (no padding) of the deflate-raw
 * compression of:
 *
 *   [1] [w] [h] [n] [name: n bytes] [shape: w*h] [elev: w*h] [walls: w*h] [tile: w*h]
 *
 * one byte per cell per layer, rows from the top, each row from x = 0; the
 * walls' low nibble only ($80:8815's bits; the high nibble is ignored). The
 * rest of a hole (the tee, the enemies, the occlusion table, the origin,
 * the song) is derived from the layers when it is loaded
 * (`fromAuthoredCourse`). A side is MIN_SIDE-MAX_SIDE cells, the name up to
 * MAX_NAME characters of the game font (features/text/encoding.ts), and
 * the underscore, which the font lacks and draws as a space.
 */
import { HoleGrid } from '../gen/grid';
import { MAX_SIDE, MIN_SIDE, type Level } from './ops';

export const CODEC_VERSION = 1;
export const MAX_NAME = 24;
/**
 * A name's characters: the game font's (features/text/encoding.ts GLYPHS;
 * test/level-codec.test.ts checks them) and the underscore (the default
 * level's CUSTOM_001), which the font draws as a space.
 */
export const NAME_CHARS = " @>,'#%()*/:.!<=?[]+-_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const HEADER = 4;
const MAX_BYTES = HEADER + MAX_NAME + 4 * MAX_SIDE * MAX_SIDE;

export class LevelDecodeError extends Error {}

/** A name the font can draw: unknown characters dropped, at most MAX_NAME. */
export function cleanName(name: string): string {
  return [...name].filter((c) => NAME_CHARS.includes(c)).join('').slice(0, MAX_NAME);
}

export function levelBytes(level: Level): Uint8Array {
  const g = level.grid;
  if (g.w < MIN_SIDE || g.h < MIN_SIDE || g.w > MAX_SIDE || g.h > MAX_SIDE) {
    throw new Error(`a level is ${MIN_SIDE}-${MAX_SIDE} cells a side, not ${g.w}x${g.h}`);
  }
  const name = new TextEncoder().encode(cleanName(level.name));
  const n = g.w * g.h;
  const out = new Uint8Array(HEADER + name.length + 4 * n);
  out[0] = CODEC_VERSION;
  out[1] = g.w;
  out[2] = g.h;
  out[3] = name.length;
  out.set(name, HEADER);
  let k = HEADER + name.length;
  out.set(g.shape, k);
  k += n;
  out.set(g.elev, k);
  k += n;
  for (let i = 0; i < n; i++) out[k + i] = g.walls[i] & 0x0f;
  k += n;
  out.set(g.tile, k);
  return out;
}

export function levelFromBytes(b: Uint8Array): Level {
  if (b.length < HEADER) throw new LevelDecodeError('the level is truncated');
  if (b[0] !== CODEC_VERSION) throw new LevelDecodeError(`level format ${b[0]} is not known (this page reads ${CODEC_VERSION})`);
  const w = b[1];
  const h = b[2];
  const nl = b[3];
  if (w < MIN_SIDE || h < MIN_SIDE || w > MAX_SIDE || h > MAX_SIDE) throw new LevelDecodeError(`bad size ${w}x${h}`);
  if (nl > MAX_NAME) throw new LevelDecodeError('the name is too long');
  const n = w * h;
  if (b.length !== HEADER + nl + 4 * n) throw new LevelDecodeError('the level is truncated or has trailing bytes');
  const name = new TextDecoder().decode(b.subarray(HEADER, HEADER + nl));
  if (cleanName(name) !== name) throw new LevelDecodeError('the name has characters the font cannot draw');
  const g = new HoleGrid(w, h);
  let k = HEADER + nl;
  g.shape.set(b.subarray(k, k + n));
  k += n;
  g.elev.set(b.subarray(k, k + n));
  k += n;
  g.walls.set(b.subarray(k, k + n));
  k += n;
  g.tile.set(b.subarray(k, k + n));
  for (let i = 0; i < n; i++) {
    if (g.shape[i] > 0x1b) throw new LevelDecodeError(`cell ${i % w},${Math.floor(i / w)}: shape $${g.shape[i].toString(16)} is not one of the 28`);
    if (g.elev[i] > 0x0f) throw new LevelDecodeError(`cell ${i % w},${Math.floor(i / w)}: elevation ${g.elev[i]} above 15`);
    if (g.walls[i] > 0x0f) throw new LevelDecodeError(`cell ${i % w},${Math.floor(i / w)}: wall bits above the low nibble`);
  }
  return { name, grid: g };
}

export async function encodeLevel(level: Level): Promise<string> {
  return toBase64Url(await deflate(levelBytes(level)));
}

export async function decodeLevel(payload: string): Promise<Level> {
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw new LevelDecodeError('the link is damaged (not base64url)');
  let packed: Uint8Array;
  try {
    packed = fromBase64Url(payload);
  } catch {
    throw new LevelDecodeError('the link is damaged (not base64url)');
  }
  return levelFromBytes(await inflate(packed));
}

/** What the hash says: the level's payload (or null) and whether to edit it. */
export function parseHash(hash: string): { payload: string | null; edit: boolean } {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const l = q.get('l');
  return { payload: l && l.length > 0 ? l : null, edit: q.has('edit') };
}

export function formatHash(payload: string | null, edit: boolean): string {
  if (payload === null) return '';
  return `#l=${payload}${edit ? '&edit' : ''}`;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflate with a cap: a payload can't make the page allocate more than a level's bytes. */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new LevelDecodeError('the level is too large');
      }
      parts.push(value);
    }
  } catch (e) {
    if (e instanceof LevelDecodeError) throw e;
    throw new LevelDecodeError('the link is damaged (does not inflate)');
  }
  const out = new Uint8Array(size);
  let k = 0;
  for (const p of parts) {
    out.set(p, k);
    k += p.length;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
