import { describe, expect, it } from 'vitest';
import { haveRomTest, haveRules, loadGolden, loadRomCourse, loadTables } from './fixtures';

describe.skipIf(!haveRules)('build/engine/rules/tables.json', () => {
  it('loads and carries the documented metadata', () => {
    const tables = loadTables();
    expect(typeof tables.about).toBe('string');
    expect(tables.zUnit).toBeGreaterThan(0);
  });
});

describe.skipIf(!haveRomTest)('build/engine/rom-test', () => {
  it('course.json is a rectangular hole with a tee inside it', () => {
    const course = loadRomCourse();
    expect(course.shape).toHaveLength(course.w * course.h);
    expect(course.elev).toHaveLength(course.w * course.h);
    expect(course.walls).toHaveLength(course.w * course.h);
    expect(course.tile).toHaveLength(course.w * course.h);
    expect(course.tee.x).toBeGreaterThanOrEqual(0);
    expect(course.tee.x).toBeLessThan(course.w);
    expect(course.tee.y).toBeGreaterThanOrEqual(0);
    expect(course.tee.y).toBeLessThan(course.h);
  });

  it('terrain_golden covers every cell × fraction², row-major then yf then xf', () => {
    const golden = loadGolden();
    expect(golden.z).toHaveLength(golden.w * golden.h * golden.fracs.length * golden.fracs.length);
  });
});
