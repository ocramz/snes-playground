/**
 * The editor's top-down grid (docs/editor.md "The editor"): x to the right,
 * y down, N up. Each cell is drawn as its four quadrant triangles shaded by
 * their corner heights (core/level/corners.ts), so terraces read as colours
 * and ramps as gradients; walls are bars along the cell's edges, steps are
 * coloured edges (amber one step, red more), markings and actors are the
 * game's pictures or glyphs, water is tinted. The pointer runs the tools:
 * a rectangle or a floor section to select; a brush that paints tiles,
 * erases them or sets shapes; a click on an edge that toggles its wall.
 * Wheel zooms, right or middle drag pans.
 */
import { DX, DY } from '../core/gen/grid';
import { cornersOf, topOf } from '../core/level/corners';
import { floorAt, rectCells } from '../core/level/select';
import { eraseTile, paintTile, setShape, toggleWall, type Level, type OpResult } from '../core/level/ops';
import { isWaterTile } from '../core/level/palette';
import type { LintResult } from '../core/level/lint';
import { isEnemyTile, TEE_TILE } from '../core/sweep';
import { HOVER_STEPS, Sprites } from './sprites';
import type { SolveReply } from './solver';

export type Tool = 'select' | 'floor' | 'paint' | 'erase' | 'wall' | 'shape';

export interface GridHost {
  level(): Level;
  lint(): LintResult | null;
  selection(): ReadonlySet<number>;
  setSelection(s: Set<number>): void;
  tool(): Tool;
  paintCode(): number;
  shapeBrush(): { shape: number; elev: number };
  /** A stroke in progress: draw this level, don't keep it yet. */
  preview(level: Level | null): void;
  commit(r: OpResult): void;
  hover(cell: { x: number; y: number } | null): void;
  plan(): SolveReply['plan'] | null;
  sprites(): Sprites | null;
}

const DIR_NAMES = ['N', 'E', 'S', 'W'];

export class GridView {
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private cs = 32;
  private ox = 0;
  private oy = 0;
  private fitted = false;
  private hoverCell: { x: number; y: number } | null = null;
  private hoverEdge = -1;
  private drag: null | {
    kind: 'pan' | 'rect' | 'stroke';
    sx: number; sy: number; ox: number; oy: number;
    start?: { x: number; y: number };
    add?: boolean;
    base?: Level;
    cells?: Set<number>;
    result?: OpResult;
  } = null;
  private previewing: Level | null = null;
  private rectSel: Set<number> | null = null;
  private raf = 0;

  constructor(private readonly parent: HTMLElement, private readonly host: GridHost) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ed-grid-canvas';
    parent.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(parent);
    this.canvas.addEventListener('pointerdown', (e) => this.down(e));
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    this.canvas.addEventListener('pointerup', (e) => this.up(e));
    this.canvas.addEventListener('pointercancel', () => this.cancel());
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverCell = null;
      this.host.hover(null);
      this.redraw();
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.resize();
  }

  /** Show the stroke's level (or the committed one). */
  setPreview(level: Level | null): void {
    this.previewing = level;
    this.redraw();
  }

  /** Fit the grid in the view (on a new level). */
  fit(): void {
    const l = this.host.level();
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) {
      this.fitted = false;
      return;
    }
    this.cs = Math.max(10, Math.min(64, Math.floor(Math.min((w - 32) / l.grid.w, (h - 32) / l.grid.h))));
    this.ox = Math.round((w - this.cs * l.grid.w) / 2);
    this.oy = Math.round((h - this.cs * l.grid.h) / 2);
    this.fitted = true;
    this.redraw();
  }

  /** A cell's centre in the page's coordinates (the e2e test clicks there). */
  clientPoint(x: number, y: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + this.ox + (x + 0.5) * this.cs, y: r.top + this.oy + (y + 0.5) * this.cs };
  }

  /** Centre a cell (the iso preview's click). */
  centreOn(x: number, y: number): void {
    this.ox = Math.round(this.canvas.clientWidth / 2 - (x + 0.5) * this.cs);
    this.oy = Math.round(this.canvas.clientHeight / 2 - (y + 0.5) * this.cs);
    this.redraw();
  }

  redraw(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.parent.clientWidth;
    const h = this.parent.clientHeight;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    if (!this.fitted) this.fit();
    this.redraw();
  }

  // --- input ---

  private cellAt(e: PointerEvent | WheelEvent): { x: number; y: number; fx: number; fy: number } {
    const r = this.canvas.getBoundingClientRect();
    const px = (e.clientX - r.left - this.ox) / this.cs;
    const py = (e.clientY - r.top - this.oy) / this.cs;
    const x = Math.floor(px);
    const y = Math.floor(py);
    return { x, y, fx: px - x, fy: py - y };
  }

  /** The edge of the cell nearest the pointer: 0-3 = N E S W. */
  private static nearestEdge(fx: number, fy: number): number {
    const d = [fy, 1 - fx, 1 - fy, fx];
    let best = 0;
    for (let k = 1; k < 4; k++) if (d[k] < d[best]) best = k;
    return best;
  }

  private inside(c: { x: number; y: number }): boolean {
    const g = this.host.level().grid;
    return c.x >= 0 && c.y >= 0 && c.x < g.w && c.y < g.h;
  }

  private down(e: PointerEvent): void {
    this.canvas.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2) {
      this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: this.ox, oy: this.oy };
      return;
    }
    if (e.button !== 0) return;
    const c = this.cellAt(e);
    const tool = this.host.tool();
    const level = this.host.level();
    const g = level.grid;
    if (tool === 'wall') {
      if (!this.inside(c)) return;
      this.host.commit(toggleWall(level, c.x, c.y, GridView.nearestEdge(c.fx, c.fy)));
      return;
    }
    if (tool === 'floor') {
      if (!this.inside(c)) {
        if (!e.shiftKey) this.host.setSelection(new Set());
        return;
      }
      const f = floorAt(g, c.x, c.y);
      if (e.shiftKey) for (const i of this.host.selection()) f.add(i);
      this.host.setSelection(f);
      return;
    }
    if (tool === 'select') {
      const start = { x: Math.max(0, Math.min(g.w - 1, c.x)), y: Math.max(0, Math.min(g.h - 1, c.y)) };
      this.drag = { kind: 'rect', sx: e.clientX, sy: e.clientY, ox: 0, oy: 0, start, add: e.shiftKey };
      this.rectSel = rectCells(g, start.x, start.y, start.x, start.y);
      this.redraw();
      return;
    }
    // the brushes
    if (!this.inside(c)) return;
    this.drag = { kind: 'stroke', sx: e.clientX, sy: e.clientY, ox: 0, oy: 0, base: level, cells: new Set() };
    this.strokeTo(c);
  }

  private strokeTo(c: { x: number; y: number }): void {
    const d = this.drag;
    if (!d || d.kind !== 'stroke' || !d.base || !d.cells || !this.inside(c)) return;
    const i = d.base.grid.at(c.x, c.y);
    if (d.cells.has(i)) return;
    d.cells.add(i);
    const tool = this.host.tool();
    if (tool === 'paint') d.result = paintTile(d.base, d.cells, this.host.paintCode());
    else if (tool === 'erase') d.result = eraseTile(d.base, d.cells);
    else if (tool === 'shape') {
      const b = this.host.shapeBrush();
      d.result = setShape(d.base, d.cells, b.shape, b.elev);
    }
    this.host.preview(d.result?.level ?? null);
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    if (d?.kind === 'pan') {
      this.ox = d.ox + (e.clientX - d.sx);
      this.oy = d.oy + (e.clientY - d.sy);
      this.redraw();
      return;
    }
    const c = this.cellAt(e);
    const inside = this.inside(c);
    const edge = inside && this.host.tool() === 'wall' ? GridView.nearestEdge(c.fx, c.fy) : -1;
    if (!inside) {
      if (this.hoverCell) {
        this.hoverCell = null;
        this.host.hover(null);
      }
    } else if (!this.hoverCell || this.hoverCell.x !== c.x || this.hoverCell.y !== c.y || edge !== this.hoverEdge) {
      this.hoverCell = { x: c.x, y: c.y };
      this.host.hover(this.hoverCell);
    }
    this.hoverEdge = edge;
    if (d?.kind === 'rect' && d.start) {
      const g = this.host.level().grid;
      const x = Math.max(0, Math.min(g.w - 1, c.x));
      const y = Math.max(0, Math.min(g.h - 1, c.y));
      this.rectSel = rectCells(g, d.start.x, d.start.y, x, y);
    } else if (d?.kind === 'stroke') {
      this.strokeTo(c);
    }
    this.redraw();
  }

  private up(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.kind === 'rect' && this.rectSel) {
      const s = new Set(this.rectSel);
      if (d.add) for (const i of this.host.selection()) s.add(i);
      this.rectSel = null;
      this.host.setSelection(s);
    } else if (d.kind === 'stroke') {
      this.host.preview(null);
      if (d.result) this.host.commit(d.result);
    }
    this.redraw();
  }

  private cancel(): void {
    if (this.drag?.kind === 'stroke') this.host.preview(null);
    this.drag = null;
    this.rectSel = null;
    this.redraw();
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const k = Math.exp(-e.deltaY * 0.0015);
    const cs = Math.max(8, Math.min(96, this.cs * k));
    this.ox = mx - ((mx - this.ox) * cs) / this.cs;
    this.oy = my - ((my - this.oy) * cs) / this.cs;
    this.cs = cs;
    this.redraw();
  }

  // --- drawing ---

  private draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    g.fillStyle = '#0d0f18';
    g.fillRect(0, 0, W, H);
    const level = this.previewing ?? this.host.level();
    const grid = level.grid;
    const cs = this.cs;
    const X = (x: number): number => this.ox + x * cs;
    const Y = (y: number): number => this.oy + y * cs;

    // the board and its gaps
    g.fillStyle = '#151827';
    g.fillRect(X(0), Y(0), grid.w * cs, grid.h * cs);
    g.strokeStyle = '#20243a';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x <= grid.w; x++) {
      g.moveTo(X(x) + 0.5, Y(0));
      g.lineTo(X(x) + 0.5, Y(grid.h));
    }
    for (let y = 0; y <= grid.h; y++) {
      g.moveTo(X(0), Y(y) + 0.5);
      g.lineTo(X(grid.w), Y(y) + 0.5);
    }
    g.stroke();

    // the ground
    for (let y = 0; y < grid.h; y++) for (let x = 0; x < grid.w; x++) {
      const i = grid.at(x, y);
      const c = cornersOf(grid.shape[i], grid.elev[i]);
      if (!c) continue;
      const s = grid.shape[i];
      const mid = (c[0] + c[1] + c[2] + c[3]) / 4 + (s === 0x02 ? 0.5 : s === 0x03 ? -0.5 : 0);
      const pts: Array<[number, number]> = [[X(x), Y(y)], [X(x + 1), Y(y)], [X(x + 1), Y(y + 1)], [X(x), Y(y + 1)]];
      const cx = X(x) + cs / 2;
      const cy = Y(y) + cs / 2;
      for (let q = 0; q < 4; q++) {
        const a = c[q];
        const b = c[(q + 1) & 3];
        const rise = mid - (a + b) / 2; // rising from this side toward the middle
        const lit = q === 0 || q === 3 ? 1 + 0.22 * rise : 1 - 0.22 * rise; // light from the NW
        g.fillStyle = heightColour((a + b + mid) / 3, lit);
        g.beginPath();
        g.moveTo(pts[q][0], pts[q][1]);
        g.lineTo(pts[(q + 1) & 3][0], pts[(q + 1) & 3][1]);
        g.lineTo(cx, cy);
        g.closePath();
        g.fill();
      }
      if (isWaterTile(grid.tile[i])) {
        g.fillStyle = 'rgba(49, 160, 170, 0.55)';
        g.fillRect(X(x), Y(y), cs, cs);
      }
      if (cs >= 26) this.cellLabel(x, y, s, grid.elev[i]);
    }

    // the steps
    const lint = this.previewing ? null : this.host.lint();
    if (lint) {
      g.lineWidth = Math.max(2, cs / 10);
      for (const e of lint.steps) {
        g.strokeStyle = Math.abs(e.delta) <= 2 ? '#ffb020' : '#ff4040';
        g.beginPath();
        if (e.dir === 1) {
          g.moveTo(X(e.x + 1), Y(e.y));
          g.lineTo(X(e.x + 1), Y(e.y + 1));
        } else {
          g.moveTo(X(e.x), Y(e.y + 1));
          g.lineTo(X(e.x + 1), Y(e.y + 1));
        }
        g.stroke();
      }
    }

    // the walls: a bar inside the cell along each walled edge
    g.fillStyle = '#f4f1e0';
    const t = Math.max(2, Math.round(cs / 9));
    for (let y = 0; y < grid.h; y++) for (let x = 0; x < grid.w; x++) {
      const w = grid.walls[grid.at(x, y)] & 0x0f;
      if (!w) continue;
      if (w & 1) g.fillRect(X(x), Y(y), cs, t);
      if (w & 2) g.fillRect(X(x + 1) - t, Y(y), t, cs);
      if (w & 4) g.fillRect(X(x), Y(y + 1) - t, cs, t);
      if (w & 8) g.fillRect(X(x), Y(y), t, cs);
    }

    // the markings and actors
    for (let y = 0; y < grid.h; y++) for (let x = 0; x < grid.w; x++) {
      const tile = grid.tile[grid.at(x, y)];
      if (tile !== 0 && !isWaterTile(tile)) drawTileGlyph(g, tile, X(x), Y(y), cs, this.host.sprites());
    }

    // the lint's cells
    if (lint) {
      for (const issue of lint.issues) {
        if (issue.severity === 'info') continue;
        g.strokeStyle = issue.severity === 'error' ? '#ff3b3b' : '#ffd23b';
        g.lineWidth = 2;
        g.setLineDash([4, 3]);
        for (const i of issue.cells) {
          const x = i % grid.w;
          const y = (i - x) / grid.w;
          g.strokeRect(X(x) + 2, Y(y) + 2, cs - 4, cs - 4);
        }
        g.setLineDash([]);
      }
    }

    // the selection
    const sel = this.rectSel ?? this.host.selection();
    if (sel.size > 0) {
      g.fillStyle = 'rgba(255, 220, 80, 0.22)';
      g.strokeStyle = 'rgba(255, 220, 80, 0.95)';
      g.lineWidth = 2;
      for (const i of sel) {
        const x = i % grid.w;
        const y = (i - x) / grid.w;
        g.fillRect(X(x), Y(y), cs, cs);
      }
      // the outline: the selected cells' edges that face an unselected cell
      g.beginPath();
      for (const i of sel) {
        const x = i % grid.w;
        const y = (i - x) / grid.w;
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d];
          const ny = y + DY[d];
          if (nx >= 0 && ny >= 0 && nx < grid.w && ny < grid.h && sel.has(grid.at(nx, ny))) continue;
          const [ax, ay, bx, by] = edgeLine(x, y, d);
          g.moveTo(X(ax), Y(ay));
          g.lineTo(X(bx), Y(by));
        }
      }
      g.stroke();
    }

    // the solver's plan: where the ball rests before each shot, and the cup
    const plan = this.host.plan();
    if (plan && plan.length > 0 && !this.previewing) {
      g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      g.lineWidth = 2;
      g.setLineDash([6, 4]);
      g.beginPath();
      const pos = (p: { xc: number; xf: number; yc: number; yf: number }): [number, number] => [X(p.xc + p.xf / 65536), Y(p.yc + p.yf / 65536)];
      plan.forEach((s, k) => {
        const [px, py] = pos(s.from);
        if (k === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
      g.stroke();
      g.setLineDash([]);
      g.font = `bold ${Math.max(10, Math.round(cs / 3))}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      plan.forEach((s, k) => {
        const [px, py] = pos(s.from);
        g.fillStyle = '#ffffff';
        g.beginPath();
        g.arc(px, py, Math.max(7, cs / 5), 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#101010';
        g.fillText(String(k + 1), px, py + 1);
      });
    }

    // the pointer
    if (this.hoverCell && !this.drag) {
      const { x, y } = this.hoverCell;
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2;
      if (this.hoverEdge >= 0) {
        const [ax, ay, bx, by] = edgeLine(x, y, this.hoverEdge);
        g.lineWidth = 4;
        g.beginPath();
        g.moveTo(X(ax), Y(ay));
        g.lineTo(X(bx), Y(by));
        g.stroke();
      } else {
        g.strokeRect(X(x) + 1, Y(y) + 1, cs - 2, cs - 2);
      }
    }
  }

  private cellLabel(x: number, y: number, shape: number, elev: number): void {
    const g = this.g;
    const cs = this.cs;
    const X = this.ox + x * cs;
    const Y = this.oy + y * cs;
    const top = topOf(shape, elev) ?? 0;
    g.font = `${Math.max(9, Math.round(cs / 4))}px system-ui, sans-serif`;
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillStyle = 'rgba(0, 0, 0, 0.55)';
    g.fillText(String(top), X + 3, Y + 2);
    if (shape >= 0x04 && shape <= 0x07) {
      // the ramp's fall
      arrow(g, X + cs / 2, Y + cs / 2, shape - 0x04, cs * 0.28, 'rgba(0, 0, 0, 0.35)', 2);
    }
  }

  static dirName(d: number): string {
    return DIR_NAMES[d & 3];
  }
}

/** A tile's picture or glyph in a cs x cs box (the grid's cells, the palette's buttons). */
export function drawTileGlyph(g: CanvasRenderingContext2D, t: number, x: number, y: number, cs: number, sp: Sprites | null): void {
  const cx = x + cs / 2;
  const cy = y + cs / 2;
  const pic = sp?.forTile(t) ?? null;
  if (pic) {
    Sprites.drawFit(g, pic, x + cs * 0.1, y + cs * 0.1, cs * 0.8, cs * 0.8);
    if (HOVER_STEPS[t]) badge(g, x + cs - 2, y + 2, `↑${HOVER_STEPS[t]}`, cs);
    return;
  }
  if (t === TEE_TILE) return disc(g, cx, cy, cs * 0.32, '#ff8a3d', 'T');
  if (t === 0x02) return disc(g, cx, cy, cs * 0.3, '#2e8b3e', 'Y');
  if (isEnemyTile(t)) return disc(g, cx, cy, cs * 0.32, '#e0457b', HOVER_STEPS[t] ? 'H' : 'E');
  if (t === 0x04) {
    g.fillStyle = 'rgba(110, 72, 30, 0.75)';
    for (let k = 0; k < 9; k++) {
      const px = x + cs * (0.2 + 0.3 * (k % 3));
      const py = y + cs * (0.2 + 0.3 * Math.floor(k / 3));
      g.fillRect(px - 1.5, py - 1.5, 3, 3);
    }
    return;
  }
  if (t >= 0x20 && t <= 0x24) {
    g.fillStyle = 'rgba(200, 240, 255, 0.55)';
    g.fillRect(x + 2, y + 2, cs - 4, cs - 4);
    return label(g, cx, cy, 'ice', '#0b3a5a', cs);
  }
  if (t >= 0x30 && t <= 0x33) return chevrons(g, cx, cy, t - 0x30, cs, '#ff3a3a');
  if (t === 0x34 || t === 0x36 || t === 0x38 || t === 0x3a) return chevrons(g, cx, cy, ((t - 0x34) / 2 + 2) & 3, cs, '#ff3a3a');
  if (t >= 0x10 && t <= 0x13) {
    arrow(g, cx, cy, t - 0x10, cs * 0.3, '#ffe14a', 3);
    return label(g, cx, cy, 'K', '#3a2a00', cs);
  }
  if (t >= 0x14 && t <= 0x17) return arrow(g, cx, cy, t - 0x14, cs * 0.34, '#4ae0ff', 4);
  if (t >= 0x18 && t <= 0x1b) {
    arrow(g, cx, cy - cs * 0.1, t - 0x18, cs * 0.3, '#b48cff', 3);
    return arrow(g, cx, cy + cs * 0.1, t - 0x18, cs * 0.3, '#b48cff', 3);
  }
  if (t >= 0xb0 && t <= 0xb3) {
    g.strokeStyle = '#c070ff';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(cx, cy, cs * 0.3, 0, Math.PI * 2);
    g.stroke();
    return arrow(g, cx, cy, t - 0xb0, cs * 0.25, '#c070ff', 2);
  }
  if (isWaterTile(t)) {
    g.fillStyle = 'rgba(49, 160, 170, 0.9)';
    g.fillRect(x + 2, y + 2, cs - 4, cs - 4);
    return;
  }
  label(g, cx, cy, t.toString(16).toUpperCase().padStart(2, '0'), '#ffffff', cs);
}

function edgeLine(x: number, y: number, d: number): [number, number, number, number] {
  if (d === 0) return [x, y, x + 1, y];
  if (d === 1) return [x + 1, y, x + 1, y + 1];
  if (d === 2) return [x, y + 1, x + 1, y + 1];
  return [x, y, x, y + 1];
}

/**
 * A terrace's colour by its height in steps (0-17), lit by `lit`: the hue
 * turns 32 degrees a step and the light rises, so neighbouring heights
 * always differ, like the bands of a contour map.
 */
export function heightColour(h: number, lit = 1): string {
  const hue = (((150 - 32 * h) % 360) + 360) % 360;
  const light = Math.max(8, Math.min(90, (26 + 3.2 * Math.min(h, 17)) * lit));
  return `hsl(${hue.toFixed(1)} 42% ${light.toFixed(1)}%)`;
}

function arrow(g: CanvasRenderingContext2D, cx: number, cy: number, d: number, len: number, colour: string, width: number): void {
  const vx = [0, 1, 0, -1][d & 3];
  const vy = [-1, 0, 1, 0][d & 3];
  g.strokeStyle = colour;
  g.lineWidth = width;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(cx - vx * len, cy - vy * len);
  g.lineTo(cx + vx * len, cy + vy * len);
  const hx = cx + vx * len;
  const hy = cy + vy * len;
  const k = len * 0.55;
  g.moveTo(hx, hy);
  g.lineTo(hx - vx * k + vy * k, hy - vy * k - vx * k);
  g.moveTo(hx, hy);
  g.lineTo(hx - vx * k - vy * k, hy - vy * k + vx * k);
  g.stroke();
  g.lineCap = 'butt';
}

function chevrons(g: CanvasRenderingContext2D, cx: number, cy: number, d: number, cs: number, colour: string): void {
  const vx = [0, 1, 0, -1][d & 3];
  const vy = [-1, 0, 1, 0][d & 3];
  const k = cs * 0.18;
  g.strokeStyle = colour;
  g.lineWidth = 3;
  for (const off of [-0.16, 0.12]) {
    const hx = cx + vx * cs * off + vx * k;
    const hy = cy + vy * cs * off + vy * k;
    g.beginPath();
    g.moveTo(hx - vx * k + vy * k, hy - vy * k - vx * k);
    g.lineTo(hx, hy);
    g.lineTo(hx - vx * k - vy * k, hy - vy * k + vx * k);
    g.stroke();
  }
}

function disc(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, colour: string, text: string): void {
  g.fillStyle = colour;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  label(g, cx, cy, text, '#ffffff', r * 3);
}

function label(g: CanvasRenderingContext2D, cx: number, cy: number, text: string, colour: string, cs: number): void {
  g.fillStyle = colour;
  g.font = `bold ${Math.max(9, Math.round(cs / 3))}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, cx, cy + 1);
}

function badge(g: CanvasRenderingContext2D, rx: number, ty: number, text: string, cs: number): void {
  g.font = `bold ${Math.max(8, Math.round(cs / 4.5))}px system-ui, sans-serif`;
  g.textAlign = 'right';
  g.textBaseline = 'top';
  g.fillStyle = '#ffffff';
  g.strokeStyle = '#000000';
  g.lineWidth = 3;
  g.strokeText(text, rx, ty);
  g.fillText(text, rx, ty);
}
