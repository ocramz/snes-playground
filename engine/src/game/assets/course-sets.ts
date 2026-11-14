/**
 * The courses the menu offers (bridge-side; core's CourseData has no notion
 * of bitmaps or songs):
 * - 'rom1': course 1 of the ROM, holes 0-7, with their exported layers
 *   (assets/holes/0N, tools/export_web.py --only course,layers);
 * - 'test': the eight authored test holes of engine/courses (README there),
 *   drawn by the procedural terrain renderer.
 * The hole song is course 1's, song 11, for both (docs/emulation.md; other
 * courses' songs are not traced: plans risk 8).
 */
import { fromAuthoredCourse, fromRomCourse, type AuthoredCourseJson, type CourseData, type CourseJson } from '../../core/course-data';
import type { RomRules } from '../../core/rules';
import { HOLE_SONG } from '../../core/systems/hole-flow';
import type { LayersJson } from './schema';

export interface HoleAssets {
  data: CourseData;
  /** The ROM hole number whose layers to draw, or null (procedural). */
  layersOf: number | null;
  layers: LayersJson | null;
  song: number;
}

export interface CourseSet {
  id: 'rom1' | 'test';
  label: string;
  holes: HoleAssets[];
}

const authored = import.meta.glob<AuthoredCourseJson>('../../../courses/*.course.json', {
  eager: true,
  import: 'default',
});

export function testCourseSet(rules: RomRules): CourseSet {
  const holes = Object.keys(authored).sort().map((k) => ({
    data: fromAuthoredCourse(authored[k], { enemyAbility: rules.table('enemyAbility') }),
    layersOf: null,
    layers: null,
    song: HOLE_SONG,
  }));
  return { id: 'test', label: 'TEST COURSES', holes };
}

export function romCourseSet(
  holes: Array<{ course: CourseJson; layers: LayersJson | null }>,
): CourseSet {
  return {
    id: 'rom1',
    label: 'COURSE 1',
    holes: holes.map((h, i) => ({ data: fromRomCourse(h.course), layersOf: i, layers: h.layers, song: HOLE_SONG })),
  };
}
