/**
 * Loads a ROM course when the menu picks it (the Preload scene loads no
 * holes): each hole's course.json and layers.json, then the bitmaps its
 * layers.json lists, through the picking scene's loader. Phaser's caches are
 * global, so a course loaded once is ready the next time.
 */
import Phaser from 'phaser';
import { holeJsonKey, holeTexKey, holeUrl } from './keys';
import { romCourseHoles, type CourseSet } from './course-sets';
import type { LayersJson } from './schema';
import type { CourseJson } from '../../core/course-data';

/** Resolves true once every hole of the set is loaded (at once if it already is). */
export function loadCourse(scene: Phaser.Scene, set: CourseSet): Promise<boolean> {
  const rom = set.rom;
  if (!rom) return Promise.resolve(set.holes.length > 0);
  const json = scene.cache.json;
  const load = scene.load;
  const queueImages = (index: number, l: LayersJson): void => {
    for (const file of Object.keys(l.files)) {
      const key = holeTexKey(index, file);
      if (!scene.textures.exists(key)) load.image(key, holeUrl(index, file));
    }
  };
  for (const h of rom.holes) {
    const ck = holeJsonKey(h.index, 'course');
    const lk = holeJsonKey(h.index, 'layers');
    if (!json.exists(ck)) load.json(ck, holeUrl(h.index, 'course.json'));
    if (json.exists(lk)) {
      queueImages(h.index, json.get(lk) as LayersJson);
    } else {
      load.json(lk, holeUrl(h.index, 'layers.json'));
      load.once(`${Phaser.Loader.Events.FILE_KEY_COMPLETE}json-${lk}`, (_k: string, _t: string, l: LayersJson) => queueImages(h.index, l));
    }
  }
  const finish = (): boolean => {
    const holes: Array<{ course: CourseJson; layers: LayersJson | null }> = [];
    for (const h of rom.holes) {
      const course = json.exists(holeJsonKey(h.index, 'course')) ? (json.get(holeJsonKey(h.index, 'course')) as CourseJson) : null;
      const layers = json.exists(holeJsonKey(h.index, 'layers')) ? (json.get(holeJsonKey(h.index, 'layers')) as LayersJson) : null;
      if (course) holes.push({ course, layers });
    }
    if (holes.length !== rom.holes.length) return false;
    set.holes = romCourseHoles(holes);
    return true;
  };
  if (load.list.size === 0) return Promise.resolve(finish());
  return new Promise((resolve) => {
    load.once(Phaser.Loader.Events.COMPLETE, () => resolve(finish()));
    load.start();
  });
}
