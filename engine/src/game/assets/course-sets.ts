/**
 * The courses the menu offers (bridge-side; core's CourseData has no notion
 * of bitmaps):
 * - 'romN': course N of the ROM, its eight holes with their exported layers
 *   (assets/holes/NNN, tools/export_web.py --only course,layers), listed by
 *   manifest.json and loaded when the course is picked (course-loader.ts);
 * - 'test': the eight authored test holes of engine/courses (README there),
 *   drawn by the styled or the procedural terrain renderer;
 * - 'random': random.html's course, generated from a seed (core/gen), drawn
 *   like the test holes, each with the solver's par;
 * - 'level': editor.html's one hole, made in the level editor (core/level).
 * The hole's song is on its CourseData: a ROM hole's from `$80:C99D`'s lists
 * (course.json `song`), the others course 1's song 11 (HOLE_SONG).
 */
import { fromAuthoredCourse, fromRomCourse, type AuthoredCourseJson, type CourseData, type CourseJson } from '../../core/course-data';
import type { RomRules } from '../../core/rules';
import type { LayersJson, ManifestCourse } from './schema';
import { GEN_VERSION, type GeneratedHole } from '../../core/gen/generate';

export interface HoleAssets {
  data: CourseData;
  /** The ROM hole index whose layers to draw, or null (styled or procedural). */
  layersOf: number | null;
  layers: LayersJson | null;
  /** The shots the solver's plan needed (random holes, and the editor's level). */
  par?: number;
}

export interface CourseSet {
  /** 'rom1'-'rom8', 'test', 'random' or 'level'. */
  id: string;
  label: string;
  /** Empty for a ROM course until course-loader.ts has loaded it. */
  holes: HoleAssets[];
  /** A ROM course: its manifest entry. */
  rom?: ManifestCourse;
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
  }));
  return { id: 'test', label: 'TEST COURSES', holes };
}

/** The manifest's ROM courses, not loaded yet. */
export function romCourseSets(courses: ManifestCourse[]): CourseSet[] {
  return courses.map((c) => ({ id: `rom${c.course + 1}`, label: `COURSE ${c.course + 1}`, holes: [], rom: c }));
}

/** A ROM course's holes from their loaded course.json and layers.json. */
export function romCourseHoles(holes: Array<{ course: CourseJson; layers: LayersJson | null }>): HoleAssets[] {
  return holes.map((h) => ({ data: fromRomCourse(h.course), layersOf: h.course.index, layers: h.layers }));
}

/** Whether a set's holes are there to play (a ROM course once loaded). */
export function isLoaded(set: CourseSet): boolean {
  return set.holes.length > 0 && (!set.rom || set.holes.length === set.rom.holes.length);
}

/** random.html's course: the generated holes, the generator's version in the label. */
/** editor.html's one hole (the level editor's): drawn like the test holes, with the solver's par once it has one. */
export function levelCourseSet(data: CourseData, label: string, par?: number): CourseSet {
  return { id: 'level', label, holes: [{ data, layersOf: null, layers: null, par }] };
}

export function randomCourseSet(holes: GeneratedHole[], seed: number): CourseSet {
  return {
    id: 'random',
    label: `RANDOM ${seed} V${GEN_VERSION}`,
    holes: holes.map((h) => ({ data: h.data, layersOf: null, layers: null, par: h.solution?.par })),
  };
}
