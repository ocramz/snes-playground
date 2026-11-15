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
 * 2, under the front layer; the engine does not model that. Kirby goes to
 * priority 1 or 2 while he is behind the course ($82:F4FD: core's
 * `BallSprite`), and his view draws him under the layers then
 * (features/kirby/sprite-rules.ts). The priority-0 sprites are masks that let
 * the course show through (object 75, the cup's rim:
 * features/enemies/cup-mask.ts). The play area's outline is not baked in:
 * `layer_outline_{back,front}` are white masks of palette 7 colour 15, which
 * object 111 ($84:81A3) cycles through the 15 colours of $98:D3E6 in a
 * ping-pong walk of 30 steps, 3 frames each (tables.json outlineColours/
 * outlineWalk; the walk's phase at the hole's start is not known). Its hook
 * $84:81B7 cycles palette 7 colour 1 the same way, 6 frames a step through
 * $98:D4C8 (`layer_glow_{back,front}`, tables.json glowColours/glowWalk).
 * The BG colour cycles of layers.json `cycles` are not baked in either:
 * object 113's ripple on a water hole (palette 4 colours 1-7, 8 frames a
 * set), object 112's on the boost panels (palette 4 colours 1-4, 4 frames)
 * and 114's or 115's on the warp or snap panels (palette 6 colours 11-15, 8
 * or 4 frames). The layers carry each cycle's set 0, and
 * `layer_{back,front}_<name><k>` are the pixels that differ under set k,
 * shown over their layer during its phases (the phases at the hole's start
 * are not known). HOLE IN ONE swaps the BG colours to the night set (hole 1
 * only: the swap was recorded on course 1's CGRAM; plans risk 10): the
 * `_night` bitmaps and backdrop.
 *
 * A hole without bitmaps (the authored test holes, random.html's holes) is
 * drawn with the course art's exemplar patches by styled.ts, with course 1's
 * BG3 scenery (Tex.scenery) and backdrop behind it, and its walls as an
 * outline mask tinted like the ROM holes'; without the style atlas (tools/
 * terrain_style.py), procedural.ts draws the data instead.
 */
import Phaser from 'phaser';
import { Tex, holeTexKey } from '../../assets/keys';
import type { LayersJson, PaletteCycle } from '../../assets/schema';
import type { RomRules } from '../../../core/rules';
import type { CourseState } from '../../../core/traits/course';
import { drawTerrain } from './procedural';
import { rasterTerrain, type TerrainStyle } from './styled';
import { DEPTH } from './layer-depth';

export { DEPTH };

/** Each styled raster's texture key is new (a hole scene restarts per hole). */
let styledSerial = 0;

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

interface CycleOverlay {
  cycle: PaletteCycle;
  set: number;
  image: Phaser.GameObjects.Image;
}

export class LayersView {
  private readonly layers: Layer[] = [];
  private readonly outlines: Phaser.GameObjects.Image[] = [];
  private readonly glows: Phaser.GameObjects.Image[] = [];
  private readonly overlays: CycleOverlay[] = [];
  private terrain: Phaser.GameObjects.Graphics | null = null;
  /** The styled raster's textures (removed with the view). */
  private readonly ownTextures: string[] = [];
  private readonly walk: number[];
  private readonly colours: Int32Array;
  private readonly glowWalk: { stepFrames: number; values: number[] } | null;
  private readonly glowColours: Int32Array | null;
  private night = false;

  constructor(
    private readonly scene: Phaser.Scene,
    rules: RomRules,
    private readonly course: CourseState,
    private readonly hole: number | null,
    private readonly info: LayersJson | null,
    debugTerrain: boolean,
    style: TerrainStyle | null = null,
  ) {
    this.walk = rules.outlineWalk;
    this.colours = rules.table('outlineColours');
    this.glowWalk = rules.glowWalk;
    this.glowColours = this.glowWalk ? rules.table('glowColours') : null;
    const bitmaps = hole !== null && info !== null && this.has('layer_back.png');
    if (bitmaps) {
      this.add('layer_bg3.png', DEPTH.bg3, true);
      this.add('layer_back.png', DEPTH.back, false);
      this.add('layer_front.png', DEPTH.front, false);
      this.addMask(this.outlines, 'layer_outline_back.png', DEPTH.outlineBack);
      this.addMask(this.outlines, 'layer_outline_front.png', DEPTH.outlineFront);
      this.addMask(this.glows, 'layer_glow_back.png', DEPTH.outlineBack);
      this.addMask(this.glows, 'layer_glow_front.png', DEPTH.outlineFront);
      for (const cycle of info?.cycles ?? []) {
        this.addCycle(cycle, 'layer_back', DEPTH.cycleBack);
        this.addCycle(cycle, 'layer_front', DEPTH.cycleFront);
      }
    }
    scene.cameras.main.setBackgroundColor(rgb(info?.backColour ?? DEFAULT_BACK));
    const styled = !bitmaps && style !== null && this.addStyled(rules, style);
    if ((!bitmaps && !styled) || debugTerrain) {
      this.terrain = drawTerrain(scene, rules, course);
      this.terrain.setDepth(DEPTH.back + 0.5);
      // over the bitmaps (?debug, key D) it covers both layers
      if (bitmaps || styled) this.terrain.setVisible(false).setAlpha(0.6).setDepth(DEPTH.outlineFront + 0.5);
    }
  }

  /**
   * The styled terrain (styled.ts) as one image at the back layer's depth,
   * the walls' mask as an outline image, and course 1's scenery behind.
   */
  private addStyled(rules: RomRules, style: TerrainStyle): boolean {
    const r = rasterTerrain(rules, this.course, style);
    const key = `styled:${++styledSerial}`;
    const tex = (data: Uint8ClampedArray, k: string): string | null => {
      const t = this.scene.textures.createCanvas(k, r.width, r.height);
      if (!t) return null;
      t.context.putImageData(new ImageData(new Uint8ClampedArray(data), r.width, r.height), 0, 0);
      t.refresh();
      this.ownTextures.push(k);
      return k;
    };
    const back = tex(r.pixels, key);
    if (!back) return false;
    this.layers.push({ file: 'styled', image: this.scene.add.image(r.x0, r.y0, back).setOrigin(0, 0).setDepth(DEPTH.back) });
    if (r.outline.some((v, i) => (i & 3) === 3 && v !== 0)) {
      const ol = tex(r.outline, `${key}:outline`);
      if (ol) this.outlines.push(this.scene.add.image(r.x0, r.y0, ol).setOrigin(0, 0).setDepth(DEPTH.outlineBack));
    }
    if (this.scene.textures.exists(Tex.scenery)) {
      this.layers.push({ file: 'bg3', image: this.scene.add.image(0, 0, Tex.scenery).setOrigin(0, 0).setDepth(DEPTH.bg3).setScrollFactor(0) });
    }
    return true;
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

  /** A white mask the view tints every frame (the outline's two colours). */
  private addMask(into: Phaser.GameObjects.Image[], file: string, depth: number): void {
    if (!this.has(file)) return;
    into.push(this.scene.add.image(0, 0, holeTexKey(this.hole!, file)).setOrigin(0, 0).setDepth(depth));
  }

  /** A cycle's overlays on one layer, `<stem>_<name><k>.png` for the sets k ≥ 1 its order names; hidden. */
  private addCycle(cycle: PaletteCycle, stem: string, depth: number): void {
    for (const set of new Set(cycle.order)) {
      const file = `${stem}_${cycle.name}${set}.png`;
      if (set === 0 || !this.has(file)) continue;
      const image = this.scene.add.image(0, 0, holeTexKey(this.hole!, file)).setOrigin(0, 0).setDepth(depth).setVisible(false);
      this.overlays.push({ cycle, set, image });
    }
  }

  /**
   * Per frame: the outline's colour from the walk ($84:81A3, 3 frames a step),
   * the glow's ($84:81B7), and each cycle's set (`stepFrames` a phase).
   */
  update(ticks: number): void {
    if (this.outlines.length > 0 && this.walk.length > 0) {
      const k = this.walk[Math.floor(ticks / 3) % this.walk.length];
      const colour = bgr555(this.colours[k] ?? 0x7fff);
      for (const o of this.outlines) o.setTint(colour);
    }
    if (this.glows.length > 0 && this.glowWalk && this.glowColours && this.glowWalk.values.length > 0) {
      const w = this.glowWalk;
      const k = w.values[Math.floor(ticks / w.stepFrames) % w.values.length];
      const colour = bgr555(this.glowColours[k] ?? 0x7fff);
      for (const g of this.glows) g.setTint(colour);
    }
    for (const o of this.overlays) {
      const c = o.cycle;
      if (c.order.length === 0 || c.stepFrames <= 0) continue;
      o.image.setVisible(c.order[Math.floor(ticks / c.stepFrames) % c.order.length] === o.set);
    }
  }

  /** The procedural terrain over the bitmaps or the styled terrain (?debug, key D). */
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
    for (const g of this.glows) g.destroy();
    for (const o of this.overlays) o.image.destroy();
    this.terrain?.destroy();
    for (const k of this.ownTextures) if (this.scene.textures.exists(k)) this.scene.textures.remove(k);
  }
}
