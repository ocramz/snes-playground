/**
 * The authored test courses (engine/courses/*.course.json; plans phase 6
 * §6): every file parses and validates, the eight together cover every
 * terrain shape and every special-tile group the engine ports, and the
 * validator rejects the mistakes it is there for.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fromAuthoredCourse, type AuthoredCourseJson, type CourseData } from '../src/core/course-data';
import { RomRules } from '../src/core/rules';
import { sweepActors } from '../src/core/sweep';
import { haveRules, loadTables } from './fixtures';

const dir = resolve(fileURLToPath(new URL('.', import.meta.url)), '../courses');
const files = readdirSync(dir).filter((f) => f.endsWith('.course.json')).sort();
const read = (f: string): AuthoredCourseJson => JSON.parse(readFileSync(resolve(dir, f), 'utf8'));

describe('the test courses', () => {
  const rules = haveRules ? new RomRules(loadTables()) : null;
  const checks = rules ? { enemyAbility: rules.table('enemyAbility') } : {};
  const holes: CourseData[] = files.map((f) => fromAuthoredCourse(read(f), checks));

  it('eight holes, t1 to t8, each named after its file', () => {
    expect(files).toHaveLength(8);
    holes.forEach((h, i) => expect(`${h.name}.course.json`).toBe(files[i]));
  });

  it('cover every terrain shape $00-$1B', () => {
    const seen = new Set<number>();
    for (const h of holes) for (const s of h.shape) seen.add(s);
    const missing = Array.from({ length: 0x1c }, (_, i) => i).filter((s) => !seen.has(s));
    expect(missing.map((s) => s.toString(16))).toEqual([]);
  });

  it('cover the special-tile groups, the steps, the walls and the gaps', () => {
    const tiles = new Set<number>();
    let walls = 0;
    let steps = 0;
    let gaps = 0;
    for (const h of holes) {
      for (const t of h.tile) tiles.add(t);
      walls += h.walls.filter((v) => v !== 0).length;
      gaps += h.shape.filter((v) => v === 0).length;
      for (let i = 0; i < h.w * h.h; i++) if (i % h.w > 0 && h.elev[i] !== h.elev[i - 1]) steps++;
    }
    const groups: Array<[string, number[]]> = [
      ['pillar $02', [0x02]], ['rough $04', [0x04]], ['hazard $05', [0x05]], ['tee $0C', [0x0c]],
      ['kickers $10-$13', [0x10, 0x11, 0x12, 0x13]], ['arrows $14-$17', [0x14, 0x15, 0x16, 0x17]],
      ['snaps $18-$1B', [0x18, 0x19, 0x1a, 0x1b]],
      ['friction $20-$24', [0x20, 0x21, 0x22, 0x23, 0x24]], ['outline $28-$2D', [0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d]],
      ['boost $30-$33', [0x30, 0x31, 0x32, 0x33]], ['ramp boost $34-$3A', [0x34, 0x36, 0x38, 0x3a]],
      ['enemies', [0x40]], ['hover enemies', [0x4d, 0x50, 0x51]],
      ['hazard $80', [0x80]], ['hazard $90', [0x90]], ['hazard $98', [0x98]], ['hazard $A2', [0xa2]],
      ['hazards $AC-$AE', [0xac, 0xad, 0xae]],
    ];
    for (const [name, want] of groups) expect(want.filter((t) => !tiles.has(t)), name).toEqual([]);
    expect(walls).toBeGreaterThan(0);
    expect(steps).toBeGreaterThan(0);
    expect(gaps).toBeGreaterThan(0);
  });

  it.skipIf(!rules)('every hole has a tee, at least two enemies, and its actors from the sweep', () => {
    for (const h of holes) {
      const a = sweepActors(rules!, h);
      expect(a.tee, h.name).toEqual(h.tee);
      expect(a.enemies.length, h.name).toBeGreaterThanOrEqual(2);
      expect(a.enemies.map((e) => `${e.x},${e.y}`), h.name).toEqual(h.enemies.map((e) => `${e.x},${e.y}`));
    }
    const t8 = sweepActors(rules!, holes[7]);
    expect(t8.enemies.map((e) => e.hover).sort()).toEqual([2, 3, 4]);
    const t7 = sweepActors(rules!, holes[6]);
    // $98-$A1 spawn no actor of their own ($82:BDBC = $FFFF): they test the others
    expect(t7.hazards.map((h) => h.type).sort((p, q) => p - q)).toEqual([0x4c, 0x4d, 0x51, 0x52, 0x53]);
    expect(t7.pillars).toHaveLength(2);
  });

  it('the validator rejects what it should', () => {
    const base = read('t1-flat.course.json');
    const bad = (patch: Partial<AuthoredCourseJson>): (() => CourseData) => () => fromAuthoredCourse({ ...base, ...patch }, checks);
    expect(bad({ w: 9 })).toThrow(/cells, expected 9/);
    const noTee = base.tile!.map((r) => r.replace('0C', '..'));
    expect(bad({ tile: noTee })).toThrow(/no tee/);
    const twoTees = [...base.tile!];
    twoTees[6] = twoTees[6].replace(/^\.\./, '0C');
    expect(bad({ tile: twoTees })).toThrow(/second tee/);
    const oneEnemy = base.tile!.map((r) => r.replace('4A', '..').replace('4B', '..'));
    expect(bad({ tile: oneEnemy })).toThrow(/at least 2/);
    const roulette = base.tile!.map((r) => r.replace('4A', '57'));
    expect(bad({ tile: roulette })).toThrow(/roulette/);
    const badShape = [...base.shape];
    badShape[0] = badShape[0].replace(/^01/, '1C');
    expect(bad({ shape: badShape })).toThrow(/not one of the 28/);
    if (rules) {
      const ability = base.tile!.map((r) => r.replace('4A', '41'));
      expect(bad({ tile: ability })).toThrow(/copy ability/);
    }
  });
});
