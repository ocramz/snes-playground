/**
 * The switches' and the swirls' pictures over a ROM hole's layers (port_v2
 * phase 6; tools/export_web.py `build_layers`, layers.json `switches`; core's
 * `Switches`, systems/switches.ts). All are overlays of the pixels that
 * differ from the layer:
 *
 * - `<stem>_togglesw<state><set>`: the toggles' switch by `$6A2A` (its tiles,
 *   `$80:D7B5` 1) and object 117's set (palette 4 colours 12-15);
 * - `<stem>_watersw<state><set>`: the water switch by `$69CA` and object
 *   118's set (palette 5 colours 12-15; its tiles do not change);
 * - `<stem>_swirl<list>_<frame>`: object 127's frames over the course
 *   page's tiles (none shown before its first upload);
 * - on a water switch's hole the layers are drawn dry and `<stem>_water` is
 *   the water, which the dissolve masks pixel by pixel (dissolve.ts) — the
 *   ripple's overlays with it, on the ripple's own clock (object 113 stops
 *   while the water is off).
 */
import Phaser from 'phaser';
import { holeTexKey } from '../../assets/keys';
import type { LayersJson, PaletteCycle } from '../../assets/schema';
import type { SwitchesState } from '../../../core/traits/switches';
import { applyDissolve, dissolveMap, type DissolveMap } from './dissolve';
import { DEPTH } from './layer-depth';

const STEMS = [
  { stem: 'layer_back', depth: DEPTH.cycleBack, water: DEPTH.back + 0.25 },
  { stem: 'layer_front', depth: DEPTH.cycleFront, water: DEPTH.front + 0.25 },
] as const;

const SWIRL_FRAMES = 10;

interface Masked {
  key: string;
  tex: Phaser.Textures.CanvasTexture;
  image: Phaser.GameObjects.Image;
  orig: Uint8ClampedArray;
  data: ImageData;
  /** 0: the water; k >= 1: the ripple's set k. */
  ripple: number;
}

interface WaterLayer {
  map: DissolveMap;
  masked: Masked[];
}

let serial = 0;

export class SwitchLayers {
  private readonly overlays = new Map<string, Phaser.GameObjects.Image>();
  private readonly water: WaterLayer[] = [];
  private shown = '';

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly hole: number,
    info: LayersJson,
    private readonly has: (file: string) => boolean,
    private readonly ripple: PaletteCycle | null,
  ) {
    const sw = info.switches!;
    for (const { stem, depth, water } of STEMS) {
      const names: string[] = [];
      for (const which of ['toggle', 'water'] as const) {
        if (sw[which] === null) continue;
        for (const s of [0, 1]) for (const k of [0, 1]) names.push(`${stem}_${which}sw${s}${k}.png`);
      }
      for (let list = 0; list < sw.swirlLists; list++) {
        for (let f = 0; f < SWIRL_FRAMES; f++) names.push(`${stem}_swirl${list}_${f}.png`);
      }
      for (const file of names) {
        if (!this.has(file)) continue;
        this.overlays.set(file, scene.add.image(0, 0, holeTexKey(hole, file)).setOrigin(0, 0).setDepth(depth).setVisible(false));
      }
      if (sw.dissolve) this.addWater(stem, water, depth);
    }
  }

  /** The water and the ripple's sets as canvases the dissolve masks. */
  private addWater(stem: string, waterDepth: number, rippleDepth: number): void {
    const mapFile = `${stem}_dissolve.png`;
    const waterFile = `${stem}_water.png`;
    if (!this.has(mapFile) || !this.has(waterFile)) return;
    const read = (file: string): ImageData | null => {
      const src = this.scene.textures.get(holeTexKey(this.hole, file)).getSourceImage() as CanvasImageSource & { width: number; height: number };
      const c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(src, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height);
    };
    const m = read(mapFile);
    if (!m) return;
    const layer: WaterLayer = { map: dissolveMap(m.data, m.width), masked: [] };
    const add = (file: string, ripple: number, depth: number): void => {
      if (!this.has(file)) return;
      const img = read(file);
      if (!img) return;
      const key = `switch-water:${++serial}`;
      const tex = this.scene.textures.createCanvas(key, img.width, img.height);
      if (!tex) return;
      tex.context.putImageData(img, 0, 0);
      tex.refresh();
      const image = this.scene.add.image(0, 0, key).setOrigin(0, 0).setDepth(depth).setVisible(ripple === 0);
      layer.masked.push({ key, tex, image, orig: new Uint8ClampedArray(img.data), data: img, ripple });
    };
    add(waterFile, 0, waterDepth);
    for (const k of new Set(this.ripple?.order ?? [])) if (k > 0) add(`${stem}_ripple${k}.png`, k, rippleDepth);
    this.water.push(layer);
  }

  /** Does this hole draw its ripple here (masked by the water) rather than as a plain cycle? */
  get ownsRipple(): boolean {
    return this.water.length > 0;
  }

  update(sw: SwitchesState): void {
    const want = new Set<string>();
    for (const { stem } of STEMS) {
      if (sw.toggle && sw.toggle.shown >= 0) want.add(`${stem}_togglesw${sw.toggle.on}${sw.toggle.shown}.png`);
      if (sw.water && sw.water.shown >= 0) want.add(`${stem}_watersw${sw.water.on}${sw.water.shown}.png`);
      // a list's tiles are its last object's upload (only 2P holes have two on one list)
      const byList = new Map<number, number>();
      for (const a of sw.anims) if (a.frame >= 0) byList.set(a.list, a.frame);
      for (const [list, frame] of byList) want.add(`${stem}_swirl${list}_${frame}.png`);
    }
    for (const [file, image] of this.overlays) image.setVisible(want.has(file));
    // the dissolve, when it moved
    const key = `${sw.dissolve.step}:${sw.dissolve.appear}`;
    if (key !== this.shown) {
      this.shown = key;
      for (const layer of this.water) {
        const m = layer.map;
        if (m.x1 < 0) continue;
        for (const c of layer.masked) {
          applyDissolve(m, c.orig, c.data.data, sw.dissolve.step, sw.dissolve.appear !== 0);
          c.tex.context.putImageData(c.data, 0, 0, m.x0, m.y0, m.x1 - m.x0 + 1, m.y1 - m.y0 + 1);
          c.tex.refresh();
        }
      }
    }
    // the ripple's set on its own clock
    const r = this.ripple;
    if (r && r.order.length > 0 && r.stepFrames > 0) {
      const set = r.order[Math.floor(sw.rippleTicks / r.stepFrames) % r.order.length];
      for (const layer of this.water) for (const c of layer.masked) if (c.ripple > 0) c.image.setVisible(c.ripple === set);
    }
  }

  destroy(): void {
    for (const image of this.overlays.values()) image.destroy();
    for (const layer of this.water) {
      for (const c of layer.masked) {
        c.image.destroy();
        if (this.scene.textures.exists(c.key)) this.scene.textures.remove(c.key);
      }
    }
  }
}
