/**
 * The editor's isometric preview: the level drawn as the game will draw it
 * (features/layers/styled.ts's rasteriser with the ROM's course art, the
 * water plane included), the tee, the trees and the enemies at the points
 * the views put them (bridge/placement.ts), scaled to fit the panel. It is
 * redrawn a moment after the edits stop. A click centres the grid on the
 * cell under the pointer (the front-most top it falls in).
 */
import { rasterTerrain, type TerrainStyle } from '../game/features/layers/styled';
import { cellCorner, teePad } from '../game/bridge/placement';
import type { RomRules } from '../core/rules';
import type { Level } from '../core/level/ops';
import { cornersOf } from '../core/level/corners';
import { isEnemyTile, TEE_TILE } from '../core/sweep';
import { HOVER_STEPS, Sprites } from './sprites';

const SKY = 'rgb(33, 57, 231)';
const DELAY_MS = 150;

/** The origin fromAuthoredCourse gives a hole (course-data.ts), for any level, valid or not. */
export function levelOrigin(level: Level): { originY: number; screenBase: number } {
  const g = level.grid;
  const maxElev = g.elev.reduce((m, v) => Math.max(m, v), 0);
  const originY = 16 * (g.h + maxElev + 2) + 32;
  return { originY, screenBase: originY + Math.max(224, 16 * (g.w + 2)) };
}

export class IsoView {
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private image: HTMLCanvasElement | null = null;
  private x0 = 0;
  private y0 = 0;
  private timer = 0;
  private level: Level | null = null;
  private fit = { k: 1, dx: 0, dy: 0 };
  /** The last raster's time, for docs/editor.md's note on the cost. */
  lastMs = 0;

  constructor(
    private readonly parent: HTMLElement,
    private readonly rules: RomRules,
    private readonly style: TerrainStyle | null,
    private readonly sprites: Sprites | null,
    private readonly onPick: (x: number, y: number) => void,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ed-iso-canvas';
    parent.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.paint()).observe(parent);
    this.canvas.addEventListener('click', (e) => this.click(e));
  }

  /** Redraw soon (the edits are still coming). */
  schedule(level: Level): void {
    this.level = level;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.render(), DELAY_MS);
  }

  /** Redraw now. */
  render(): void {
    const level = this.level;
    if (!level) return;
    const t0 = performance.now();
    const g = level.grid;
    const origin = levelOrigin(level);
    const course = { w: g.w, h: g.h, shape: g.shape, elev: g.elev, walls: g.walls, layer2: g.tile, ...origin };
    if (!this.style) {
      this.image = null;
      this.paint();
      return;
    }
    const r = rasterTerrain(this.rules, course, this.style);
    const img = document.createElement('canvas');
    img.width = r.width;
    img.height = r.height;
    const ig = img.getContext('2d')!;
    ig.fillStyle = SKY;
    ig.fillRect(0, 0, r.width, r.height);
    const terrain = document.createElement('canvas');
    terrain.width = r.width;
    terrain.height = r.height;
    terrain.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.pixels), r.width, r.height), 0, 0);
    ig.drawImage(terrain, 0, 0);
    // the walls: the outline mask in the play area's outline colour (white here)
    const walls = document.createElement('canvas');
    walls.width = r.width;
    walls.height = r.height;
    walls.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.outline), r.width, r.height), 0, 0);
    ig.drawImage(walls, 0, 0);
    // the actors, back to front
    if (this.sprites) {
      const actors: Array<{ x: number; y: number; t: number }> = [];
      for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
        const t = g.tile[g.at(x, y)];
        if (g.shape[g.at(x, y)] !== 0 && (t === TEE_TILE || t === 0x02 || isEnemyTile(t))) actors.push({ x, y, t });
      }
      const placed = actors.map((a) => {
        const p = a.t === TEE_TILE
          ? teePad(this.rules, { ...course, tee: { x: a.x, y: a.y } })
          : cellCorner(this.rules, course, a.x, a.y, HOVER_STEPS[a.t] ?? 0);
        return { ...a, p };
      });
      placed.sort((a, b) => a.x - a.y - (b.x - b.y) || a.p.y - b.p.y);
      for (const a of placed) {
        const s = this.sprites.forTile(a.t);
        if (s) Sprites.draw(ig, s, a.p.x - r.x0, a.p.y - r.y0);
      }
    }
    this.image = img;
    this.x0 = r.x0;
    this.y0 = r.y0;
    this.lastMs = performance.now() - t0;
    this.paint();
  }

  private paint(): void {
    const dpr = window.devicePixelRatio || 1;
    const W = this.parent.clientWidth;
    const H = this.parent.clientHeight;
    this.canvas.width = Math.max(1, Math.round(W * dpr));
    this.canvas.height = Math.max(1, Math.round(H * dpr));
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = SKY;
    g.fillRect(0, 0, W, H);
    if (!this.image) {
      g.fillStyle = '#ffffff';
      g.font = '12px system-ui, sans-serif';
      g.fillText(this.style ? '' : 'no course art (terrain_style): make engine-assets', 8, 20);
      return;
    }
    const k = Math.min(W / this.image.width, H / this.image.height);
    const scale = k >= 1 ? Math.floor(k) : k;
    const dw = this.image.width * scale;
    const dh = this.image.height * scale;
    const dx = (W - dw) / 2;
    const dy = (H - dh) / 2;
    g.imageSmoothingEnabled = scale < 1;
    g.drawImage(this.image, dx, dy, dw, dh);
    this.fit = { k: scale, dx, dy };
  }

  private click(e: MouseEvent): void {
    const level = this.level;
    if (!level || !this.image) return;
    const r = this.canvas.getBoundingClientRect();
    const bx = (e.clientX - r.left - this.fit.dx) / this.fit.k + this.x0;
    const by = (e.clientY - r.top - this.fit.dy) / this.fit.k + this.y0;
    const g = level.grid;
    const { originY } = levelOrigin(level);
    let best: { x: number; y: number; depth: number } | null = null;
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      const c = cornersOf(g.shape[g.at(x, y)], g.elev[g.at(x, y)]);
      if (!c) continue;
      // the top's four corners on the bitmap: NW, NE, SE, SW
      const q: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v], k) => [
        32 * (x + u + y + v), originY + 16 * (x + u - (y + v)) - 16 * c[k],
      ]);
      if (!inQuad(bx, by, q)) continue;
      const depth = x - y;
      if (!best || depth > best.depth) best = { x, y, depth };
    }
    if (best) this.onPick(best.x, best.y);
  }
}

function inQuad(px: number, py: number, q: Array<[number, number]>): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i];
    const [bx, by] = q[(i + 1) & 3];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}
