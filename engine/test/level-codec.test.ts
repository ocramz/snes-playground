/**
 * A level in a URL (src/core/level/codec.ts): encode and decode are
 * byte-exact on the test holes, the default level and generated holes; the
 * payload stays short; damaged links are refused cleanly; the hash's two
 * forms parse.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RomRules } from '../src/core/rules';
import { haveRules, loadTables } from './fixtures';
import { HoleGrid } from '../src/core/gen/grid';
import type { AuthoredCourseJson } from '../src/core/course-data';
import { generateHole, runToEnd } from '../src/core/gen/generate';
import {
  CODEC_VERSION, LevelDecodeError, NAME_CHARS, cleanName, decodeLevel, encodeLevel, formatHash, levelBytes, parseHash,
} from '../src/core/level/codec';
import { defaultLevel } from '../src/core/level/default-level';
import type { Level } from '../src/core/level/ops';
import { retroFontChars } from '../src/game/features/text/encoding';

const here = fileURLToPath(new URL('.', import.meta.url));
const coursesDir = resolve(here, '../courses');

function testHoles(): Level[] {
  return readdirSync(coursesDir)
    .filter((f) => f.endsWith('.course.json'))
    .map((f) => {
      const json = JSON.parse(readFileSync(resolve(coursesDir, f), 'utf8')) as AuthoredCourseJson;
      return { name: cleanName(json.name.toUpperCase()), grid: HoleGrid.fromJson(json) };
    });
}

const same = (a: Level, b: Level): void => {
  expect(b.name).toBe(a.name);
  expect([b.grid.w, b.grid.h]).toEqual([a.grid.w, a.grid.h]);
  expect(Array.from(b.grid.shape)).toEqual(Array.from(a.grid.shape));
  expect(Array.from(b.grid.elev)).toEqual(Array.from(a.grid.elev));
  expect(Array.from(b.grid.walls)).toEqual(Array.from(a.grid.walls).map((w) => w & 0x0f));
  expect(Array.from(b.grid.tile)).toEqual(Array.from(a.grid.tile));
};

describe('the level codec', () => {
  it('the names are the font\'s characters, and the underscore', () => {
    const font = new Set(retroFontChars());
    for (const c of NAME_CHARS) if (c !== '_') expect(font.has(c), c).toBe(true);
    expect(font.has('_')).toBe(false); // drawn as a space (fontSafe)
    expect(cleanName('Hole #1: ÜBER~')).toBe('Hole #1: BER');
    expect(cleanName('CUSTOM_001')).toBe('CUSTOM_001');
  });

  it('round-trips the test holes and the default level byte for byte', async () => {
    for (const l of [defaultLevel(), ...testHoles()]) {
      const p = await encodeLevel(l);
      expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
      same(l, await decodeLevel(p));
    }
  });

  it('a payload is short: the test holes under 600 characters', async () => {
    for (const l of testHoles()) {
      const p = await encodeLevel(l);
      expect(p.length, l.name).toBeLessThan(600);
    }
    // the worst case: a full 32 x 32 of noise
    const g = new HoleGrid(32, 32);
    let s = 1;
    const rnd = (): number => (s = (s * 1103515245 + 12345) >>> 0) >>> 24;
    for (let i = 0; i < 1024; i++) {
      g.shape[i] = rnd() % 0x1c;
      g.elev[i] = rnd() % 16;
      g.walls[i] = rnd() % 16;
      g.tile[i] = rnd();
    }
    const p = await encodeLevel({ name: 'NOISE', grid: g });
    expect(p.length).toBeLessThan(6000);
  });

  it('refuses damaged links with a LevelDecodeError', async () => {
    const good = await encodeLevel(defaultLevel());
    const bad = [
      '', 'not base64!', good.slice(0, 20), 'AAAA',
      await encodeBytes(new Uint8Array([CODEC_VERSION + 1, 4, 4, 0])),
      await encodeBytes(new Uint8Array([CODEC_VERSION, 4, 4, 0, ...new Array(63).fill(0)])),
      await encodeBytes(new Uint8Array([CODEC_VERSION, 40, 4, 0, ...new Array(640).fill(0)])),
      await encodeBytes(new Uint8Array([CODEC_VERSION, 4, 4, 0, ...new Array(16).fill(0x1c), ...new Array(48).fill(0)])),
      await encodeBytes(new Uint8Array(100_000)),
    ];
    for (const p of bad) await expect(decodeLevel(p), p.slice(0, 16)).rejects.toBeInstanceOf(LevelDecodeError);
  });

  it('parses and writes the hash', () => {
    expect(parseHash('')).toEqual({ payload: null, edit: false });
    expect(parseHash('#edit')).toEqual({ payload: null, edit: true });
    expect(parseHash('#l=abc_-9')).toEqual({ payload: 'abc_-9', edit: false });
    expect(parseHash('#l=abc&edit')).toEqual({ payload: 'abc', edit: true });
    expect(formatHash('abc', false)).toBe('#l=abc');
    expect(formatHash('abc', true)).toBe('#l=abc&edit');
    expect(formatHash(null, true)).toBe('');
    expect(levelBytes(defaultLevel())[0]).toBe(CODEC_VERSION);
  });
});

describe.skipIf(!haveRules)('generated holes through the codec', () => {
  const rules = haveRules ? new RomRules(loadTables()) : (null as unknown as RomRules);

  it('20 random holes round-trip', async () => {
    let longest = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const h = runToEnd(generateHole(rules, seed * 7919, 0, { difficulty: (seed % 3) as 0 | 1 | 2 }));
      const l: Level = { name: `RND ${seed}`, grid: HoleGrid.fromJson(h.json) };
      const p = await encodeLevel(l);
      longest = Math.max(longest, p.length);
      same(l, await decodeLevel(p));
    }
    // measured 2026-11-16: random holes (up to 24 x 24) stay well under a kilobyte
    expect(longest).toBeLessThan(1000);
  }, 60_000);
});

async function encodeBytes(b: Uint8Array): Promise<string> {
  const stream = new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const packed = new Uint8Array(await new Response(stream).arrayBuffer());
  let s = '';
  for (const x of packed) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
