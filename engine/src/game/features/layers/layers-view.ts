/**
 * The course's pictures (plans "Features: layers"). A shipped ROM hole has
 * the exported bitmaps (tools/export_web.py --only layers, docs/web-demo.md):
 * back to front,
 *   BG3          the scenery, one screen, fixed to the screen
 *   back         BG2.0 + BG1.0, the course at world (0, 0)
 *   front        BG2.1 + BG1.1
 *   [sprites]
 * with the backdrop colour behind. Every sprite of play is OAM priority 3,
 * which mode 1 draws over BG1.1 and BG2.1 (tools/ppu_render.py): Kirby, the
 * trees, the enemies, the tee and the cup in every snapshot of web_hole0
 * from 2185 on (play and the hole-out; read 2026-11-14). Only the intro's
 * frames before 2185, while the screen is black or fading in, use priority
 * 2, under the front layer; the engine does not model that. The priority-0
 * sprites are masks that let the course show through (object 75, the cup's
 * rim: features/enemies/cup-mask.ts). The play area's outline is not baked in:
 * `layer_outline_{back,front}` are white masks of palette 7 colour 15, which
 * object $84:81A3 cycles through the 15 colours of $98:D3E6 in a ping-pong
 * walk of 30 steps, 3 frames each (tables.json outlineColours/outlineWalk;
 * the walk's phase at the hole's start is not known). HOLE IN ONE swaps the
 * BG colours to the night set (hole 1 only: the swap was recorded on course
 * 1's CGRAM; plans risk 10): the `_night` bitmaps and backdrop.
 *
 * An authored course has no bitmaps: procedural.ts draws it.
 */
import Phaser from 'phaser';
import { holeTexKey } from '../../assets/keys';
import type { LayersJson } from '../../assets/schema';
import type { RomRules } from '../../../core/rules';
import type { CourseState } from '../../../core/traits/course';
import { drawTerrain } from './procedural';

export const DEPTH = {
  bg3: 0,
  back: 10,
  outlineBack: 11,
  front: 12,
  outlineFront: 13,
} as const;

/** The backdrop of every course-1 hole (layers.json backColour), also behind the authored ones. */
const DEFAULT_BACK: [number, number, number] = [33, 57, 231];

const rgb = (c: [number, number, number]): number => (c[0] << 16) | (c[1] << 8) | c[2];

export function bgr555(v: number): number {
  const r = (v & 31) << 3;
  const g = ((v >> 5) & 31) << 3;
  const b = ((v >> 10) & 31) << 3;
  return (r << 16) | (g << 8) | b;
}

interface Layer {
  file: string;
  image: Phaser.GameObjects.Image;
}

export class LayersView {
  private readonly layers: Layer[] = [];
  private readonly outlines: Phaser.GameObjects.Image[] = [];
  private terrain: Phaser.GameObjects.Graphics | null = null;
  private readonly walk: number[];
  private readonly colours: Int32Array;
  private night = false;

  constructor(
    private readonly scene: Phaser.Scene,
    rules: RomRules,
    private readonly course: CourseState,
    private readonly hole: number | null,
    private readonly info: LayersJson | null,
    debugTerrain: boolean,
  ) {
    this.walk = rules.outlineWalk;
    this.colours = rules.table('outlineColours');
    const bitmaps = hole !== null && info !== null && this.has('layer_back.png');
    if (bitmaps) {
      this.add('layer_bg3.png', DEPTH.bg3, true);
      this.add('layer_back.png', DEPTH.back, false);
      this.add('layer_front.png', DEPTH.front, false);
      this.addOutline('layer_outline_back.png', DEPTH.outlineBack);
      this.addOutline('layer_outline_front.png', DEPTH.outlineFront);
    }
    scene.cameras.main.setBackgroundColor(rgb(info?.backColour ?? DEFAULT_BACK));
    if (!bitmaps || debugTerrain) {
      this.terrain = drawTerrain(scene, rules, course);
      this.terrain.setDepth(DEPTH.back + 0.5);
      // over the bitmaps (?debug, key D) it covers both layers
      if (bitmaps) this.terrain.setVisible(false).setAlpha(0.6).setDepth(DEPTH.outlineFront + 0.5);
    }
  }

  private has(file: string): boolean {
    return this.hole !== null && file in (this.info?.files ?? {}) && this.scene.textures.exists(holeTexKey(this.hole, file));
  }

  private add(file: string, depth: number, screenFixed: boolean): void {
    if (!this.has(file)) return;
    const image = this.scene.add.image(0, 0, holeTexKey(this.hole!, file)).setOrigin(0, 0).setDepth(depth);
    if (screenFixed) image.setScrollFactor(0);
    this.layers.push({ file, image });
  }

  private addOutline(file: string, depth: number): void {
    if (!this.has(file)) return;
    this.outlines.push(this.scene.add.image(0, 0, holeTexKey(this.hole!, file)).setOrigin(0, 0).setDepth(depth));
  }

  /** Per frame: the outline's colour from the walk ($84:81A3, 3 frames a step). */
  update(ticks: number): void {
    if (this.outlines.length === 0 || this.walk.length === 0) return;
    const k = this.walk[Math.floor(ticks / 3) % this.walk.length];
    const colour = bgr555(this.colours[k] ?? 0x7fff);
    for (const o of this.outlines) o.setTint(colour);
  }

  /** The procedural terrain over the bitmaps (?debug, key D). */
  toggleTerrain(): void {
    if (!this.terrain) return;
    if (this.layers.length > 0) this.terrain.setVisible(!this.terrain.visible);
  }

  /** HOLE IN ONE's night colours, where the hole has them. Returns whether it changed. */
  setNight(on: boolean): boolean {
    if (on === this.night || this.hole === null) return false;
    const swaps = this.layers.filter((l) => this.has(l.file.replace('.png', '_night.png')));
    if (swaps.length === 0) return false;
    for (const l of swaps) {
      const file = on ? l.file.replace('.png', '_night.png') : l.file;
      l.image.setTexture(holeTexKey(this.hole, file));
    }
    const back = on ? this.info?.nightBackColour ?? this.info?.backColour : this.info?.backColour;
    if (back) this.scene.cameras.main.setBackgroundColor(rgb(back));
    this.night = on;
    return true;
  }

  get hasBitmaps(): boolean {
    return this.layers.length > 0;
  }

  get size(): { w: number; h: number } {
    const back = this.layers.find((l) => l.file === 'layer_back.png');
    if (back) return { w: back.image.width, h: back.image.height };
    return { w: 32 * (this.course.w + this.course.h), h: this.course.screenBase };
  }

  destroy(): void {
    for (const l of this.layers) l.image.destroy();
    for (const o of this.outlines) o.destroy();
    this.terrain?.destroy();
  }
}
