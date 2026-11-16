/**
 * The level editor's screen (docs/editor.md "The editor"): the header (the
 * name, new levels, undo and redo, Play and Share), the tools and the
 * operations on the left, the top-down grid in the middle, the isometric
 * preview, the par and the lint on the right, the status line below.
 * Every change goes through core/level's operations into the undo history;
 * after each, the level is linted at once and the preview, the par and the
 * page's URL follow a moment later.
 */
import type { RomRules } from '../core/rules';
import type { AuthoredCourseJson } from '../core/course-data';
import { HoleGrid } from '../core/gen/grid';
import { buildHole } from '../core/gen/generate';
import {
  autoFence, blend, clearWalls, cropToContent, dig, eraseTile, fill, flatten, paintTile, raise, resize,
  MAX_SIDE, MIN_SIDE, type Level, type OpResult,
} from '../core/level/ops';
import { allCells } from '../core/level/select';
import { lintLevel, type LintResult } from '../core/level/lint';
import { PALETTE, WATER, paletteEntry, isWaterTile, type PaletteGroup } from '../core/level/palette';
import { cornersOf, topOf } from '../core/level/corners';
import { cleanName, MAX_NAME } from '../core/level/codec';
import { defaultLevel } from '../core/level/default-level';
import type { TerrainStyle } from '../game/features/layers/styled';
import { History } from './history';
import { GridView, drawTileGlyph, heightColour, type Tool } from './grid-view';
import { IsoView } from './iso-view';
import { Sprites } from './sprites';
import { SolverClient, type SolveReply } from './solver';

export interface EditorDeps {
  rules: RomRules;
  style: TerrainStyle | null;
  sprites: Sprites | null;
  solver: SolverClient | null;
  templates: Array<{ name: string; json: AuthoredCourseJson }>;
  /** Play the level (it passed the lint). */
  onPlay(level: Level): void;
  /** Share the level (it passed the lint). */
  onShare(level: Level): void;
  /** The level changed (the page keeps it in its URL). */
  onChange(level: Level): void;
}

type SolveState =
  | { kind: 'idle' }
  | { kind: 'blocked' }
  | { kind: 'solving' }
  | { kind: 'done'; reply: SolveReply; safe: boolean };

const SOLVE_DELAY_MS = 400;
const TOOLS: Array<{ id: Tool; label: string; key: string; title: string }> = [
  { id: 'floor', label: 'Floor', key: '1', title: 'Click a terrace to select its floor section (Shift adds)' },
  { id: 'select', label: 'Select', key: '2', title: 'Drag a rectangle (Shift adds)' },
  { id: 'paint', label: 'Paint', key: '3', title: 'Paint the palette\'s tile' },
  { id: 'erase', label: 'Erase', key: '4', title: 'Erase markings and actors' },
  { id: 'wall', label: 'Walls', key: '5', title: 'Click near an edge to toggle its wall' },
  { id: 'shape', label: 'Shape', key: '6', title: 'Paint a terrain shape at an elevation' },
];
const GROUP_NAMES: Record<PaletteGroup, string> = {
  tee: 'Tee', enemy: 'Enemies', hover: 'Hovering enemies', tree: 'Trees', rough: 'Rough', friction: 'Ice',
  boost: 'Boosts', kicker: 'Kickers', arrow: 'Arrows', snap: 'Snaps', warp: 'Warps (one pair)', water: 'Water',
};
const DIRS = ['N', 'E', 'S', 'W'];
const DIAG = ['NE', 'SE', 'SW', 'NW'];

export function shapeName(s: number): string {
  if (s === 0) return 'gap';
  if (s === 1) return 'flat';
  if (s === 2) return 'mound';
  if (s === 3) return 'dimple';
  if (s <= 0x07) return `ramp falling ${DIRS[s - 4]}`;
  if (s <= 0x0b) return `corner, 3 up, falling ${DIAG[s - 8]}`;
  if (s <= 0x0f) return `corner, 1 up, falling ${DIAG[s - 0x0c]}`;
  if (s <= 0x13) return `diagonal corner, 3 up, falling ${DIAG[s - 0x10]}`;
  if (s <= 0x17) return `diagonal corner, 1 up, falling ${DIAG[s - 0x14]}`;
  return `diagonal ramp falling ${DIAG[s - 0x18]}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  if (text !== undefined) e.textContent = text;
  return e;
}

export class Editor {
  readonly root: HTMLElement;
  private history: History;
  private sel = new Set<number>();
  private toolId: Tool = 'floor';
  private code = 0x40;
  private brush = { shape: 0x04, elev: 1 };
  private slope = true;
  private showPlan = false;
  private lintResult: LintResult | null = null;
  private solveState: SolveState = { kind: 'idle' };
  private solveTimer = 0;
  private solveSeq = 0;
  private previewLevel: Level | null = null;

  private readonly grid: GridView;
  private readonly iso: IsoView;
  private readonly nameInput: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly hoverLine: HTMLElement;
  private readonly lintList: HTMLElement;
  private readonly parLine: HTMLElement;
  private readonly sizeLine: HTMLElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  private readonly playButton: HTMLButtonElement;
  private readonly shareButton: HTMLButtonElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  private readonly paletteButtons = new Map<number, HTMLButtonElement>();
  private readonly shapeButtons = new Map<number, HTMLButtonElement>();
  private readonly elevInput: HTMLInputElement;
  private readonly advanced: HTMLDetailsElement;
  private readonly onKey = (e: KeyboardEvent): void => this.key(e);

  constructor(parent: HTMLElement, private readonly deps: EditorDeps, level: Level) {
    this.history = new History(level);
    this.root = el('div', { id: 'editor' });
    parent.appendChild(this.root);

    // --- the header ---
    const header = el('header', { class: 'ed-header' });
    header.appendChild(el('span', { class: 'ed-title' }, 'Level editor'));
    this.nameInput = el('input', { class: 'ed-name', maxlength: String(MAX_NAME), spellcheck: 'false', 'aria-label': 'Level name' });
    this.nameInput.addEventListener('input', () => {
      const clean = cleanName(this.nameInput.value);
      if (clean !== this.nameInput.value) this.nameInput.value = clean;
    });
    this.nameInput.addEventListener('change', () => this.rename(this.nameInput.value));
    header.appendChild(this.nameInput);
    const newMenu = el('select', { class: 'ed-new', 'aria-label': 'New level' });
    newMenu.appendChild(el('option', { value: '' }, 'New…'));
    newMenu.appendChild(el('option', { value: 'default' }, 'Default level'));
    newMenu.appendChild(el('option', { value: 'empty' }, 'Empty island'));
    newMenu.appendChild(el('option', { value: 'random' }, 'Random layout'));
    deps.templates.forEach((t, k) => newMenu.appendChild(el('option', { value: `t${k}` }, `Test hole: ${t.name}`)));
    newMenu.addEventListener('change', () => {
      const v = newMenu.value;
      newMenu.value = '';
      this.newLevel(v);
    });
    header.appendChild(newMenu);
    this.undoButton = this.button(header, 'Undo', () => this.undo(), 'Undo (Ctrl+Z)');
    this.redoButton = this.button(header, 'Redo', () => this.redo(), 'Redo (Ctrl+Shift+Z)');
    header.appendChild(el('span', { class: 'ed-spacer' }));
    this.playButton = this.button(header, '▶ Play', () => this.play(), 'Play the level (P)');
    this.playButton.classList.add('ed-primary');
    this.shareButton = this.button(header, 'Share link', () => this.share(), 'Copy a link that plays this level');
    this.root.appendChild(header);

    // --- the tools ---
    const tools = el('aside', { class: 'ed-tools' });
    tools.appendChild(el('h3', {}, 'Tools'));
    const toolRow = el('div', { class: 'ed-row ed-wrap' });
    for (const t of TOOLS) {
      const b = this.button(toolRow, t.label, () => this.setTool(t.id), `${t.title} (${t.key})`);
      b.dataset.tool = t.id;
      this.toolButtons.set(t.id, b);
    }
    tools.appendChild(toolRow);

    tools.appendChild(el('h3', {}, 'Selection'));
    const ops = el('div', { class: 'ed-row ed-wrap' });
    this.button(ops, 'Raise +', () => this.raise(1), 'Raise the selection one step (+)').dataset.op = 'raise';
    this.button(ops, 'Lower −', () => this.raise(-1), 'Lower the selection one step (-)').dataset.op = 'lower';
    tools.appendChild(ops);
    const slopeLabel = el('label', { class: 'ed-check' });
    const slopeBox = el('input', { type: 'checkbox' });
    slopeBox.checked = true;
    slopeBox.addEventListener('change', () => {
      this.slope = slopeBox.checked;
    });
    slopeLabel.append(slopeBox, ' Slope the edges');
    slopeLabel.title = 'On: the ground around the selection follows it as ramps. Off: cliffs.';
    tools.appendChild(slopeLabel);
    const ops2 = el('div', { class: 'ed-row ed-wrap' });
    this.button(ops2, 'Blend', () => this.op((l, s) => blend(l, s)), 'Join the selection to the ground around it with ramps (B)');
    this.button(ops2, 'Flatten', () => this.flatten(), 'Make the selection flat at its commonest height');
    this.button(ops2, 'Dig', () => this.op((l, s) => dig(l, s)), 'Turn the selection into gaps (Delete)');
    this.button(ops2, 'Fill', () => this.op((l, s) => fill(l, s)), 'Fill the selection\'s gaps with flat ground (F)');
    this.button(ops2, 'Paint', () => this.op((l, s) => paintTile(l, s, this.code)), 'Paint the palette\'s tile on the selection');
    this.button(ops2, 'Erase', () => this.op((l, s) => eraseTile(l, s)), 'Erase the selection\'s markings');
    this.button(ops2, 'All', () => this.select(allCells(this.level.grid)), 'Select every cell (Ctrl+A)');
    this.button(ops2, 'None', () => this.select(new Set()), 'Clear the selection (Esc)');
    tools.appendChild(ops2);

    tools.appendChild(el('h3', {}, 'Walls'));
    const walls = el('div', { class: 'ed-row ed-wrap' });
    this.button(walls, 'Fence', () => this.commit(autoFence(this.level)), 'Wall every edge that faces a gap or the border');
    this.button(walls, 'Clear', () => this.commit(clearWalls(this.level)), 'Remove every wall');
    tools.appendChild(walls);

    tools.appendChild(el('h3', {}, 'Grid'));
    this.sizeLine = el('div', { class: 'ed-size' });
    tools.appendChild(this.sizeLine);
    const sides = el('div', { class: 'ed-sides' });
    for (const [side, label] of [['n', 'N'], ['w', 'W'], ['e', 'E'], ['s', 'S']] as const) {
      const box = el('div', { class: `ed-side ed-side-${side}` });
      box.appendChild(el('span', {}, label));
      this.button(box, '+', () => this.commit(resize(this.level, { [side]: 1 })), `Add a row or column on the ${label} side`);
      this.button(box, '−', () => this.commit(resize(this.level, { [side]: -1 })), `Remove the row or column on the ${label} side`);
      sides.appendChild(box);
    }
    tools.appendChild(sides);
    this.button(tools, 'Crop to the ground', () => this.commit(cropToContent(this.level)));

    tools.appendChild(el('h3', {}, 'Palette'));
    const pal = el('div', { class: 'ed-palette' });
    let group: PaletteGroup | null = null;
    let row: HTMLElement | null = null;
    for (const e of PALETTE) {
      if (e.group !== group) {
        group = e.group;
        pal.appendChild(el('div', { class: 'ed-group' }, GROUP_NAMES[group]));
        row = el('div', { class: 'ed-row ed-wrap' });
        pal.appendChild(row);
      }
      const b = el('button', { class: 'ed-swatch', title: e.note ? `${e.label}: ${e.note}` : e.label, 'aria-label': e.label });
      b.appendChild(this.tileIcon(e.code));
      b.addEventListener('click', () => {
        this.code = e.code;
        this.setTool('paint');
        this.syncButtons();
      });
      row!.appendChild(b);
      this.paletteButtons.set(e.code, b);
    }
    tools.appendChild(pal);

    // the shape brush: a manual tool, folded away (opened when the Shape tool is picked)
    this.advanced = el('details', { class: 'ed-advanced' });
    this.advanced.appendChild(el('summary', {}, 'Advanced'));
    this.advanced.appendChild(el('h3', {}, 'Shape brush'));
    const shapes = el('div', { class: 'ed-row ed-wrap' });
    for (let s = 1; s <= 0x1b; s++) {
      const b = el('button', { class: 'ed-swatch', title: `$${s.toString(16).toUpperCase().padStart(2, '0')} ${shapeName(s)}` });
      b.appendChild(this.shapeIcon(s));
      b.addEventListener('click', () => {
        this.brush = { ...this.brush, shape: s };
        this.setTool('shape');
        this.syncButtons();
      });
      shapes.appendChild(b);
      this.shapeButtons.set(s, b);
    }
    this.advanced.appendChild(shapes);
    const elevLabel = el('label', { class: 'ed-check' }, 'Elevation ');
    this.elevInput = el('input', { type: 'number', min: '0', max: '15', value: String(this.brush.elev), class: 'ed-elev' });
    this.elevInput.addEventListener('change', () => {
      const v = Math.max(0, Math.min(15, Math.round(Number(this.elevInput.value) || 0)));
      this.elevInput.value = String(v);
      this.brush = { ...this.brush, elev: v };
    });
    elevLabel.appendChild(this.elevInput);
    this.advanced.appendChild(elevLabel);
    tools.appendChild(this.advanced);
    this.root.appendChild(tools);

    // --- the grid ---
    const main = el('main', { class: 'ed-main' });
    this.root.appendChild(main);
    this.grid = new GridView(main, {
      level: () => this.level,
      lint: () => this.lintResult,
      selection: () => this.sel,
      setSelection: (s) => this.select(s),
      tool: () => this.toolId,
      paintCode: () => this.code,
      shapeBrush: () => this.brush,
      preview: (l) => {
        this.previewLevel = l;
        this.grid.setPreview(l);
      },
      commit: (r) => this.commit(r),
      hover: (c) => this.hover(c),
      plan: () => (this.showPlan && this.solveState.kind === 'done' && this.solveState.reply.ok ? this.solveState.reply.plan : null),
      sprites: () => deps.sprites,
    });

    // --- the side: the preview, the par, the lint ---
    const side = el('aside', { class: 'ed-sidebar' });
    const isoBox = el('div', { class: 'ed-iso' });
    side.appendChild(isoBox);
    this.iso = new IsoView(isoBox, deps.rules, deps.style, deps.sprites, (x, y) => this.grid.centreOn(x, y));
    side.appendChild(el('h3', {}, 'Par'));
    this.parLine = el('div', { class: 'ed-par' });
    side.appendChild(this.parLine);
    const planLabel = el('label', { class: 'ed-check' });
    const planBox = el('input', { type: 'checkbox' });
    planBox.addEventListener('change', () => {
      this.showPlan = planBox.checked;
      this.grid.redraw();
    });
    planLabel.append(planBox, ' Show the solver\'s plan');
    side.appendChild(planLabel);
    side.appendChild(el('h3', {}, 'Checks'));
    this.lintList = el('ul', { class: 'ed-lint' });
    side.appendChild(this.lintList);
    this.root.appendChild(side);

    // --- the status line ---
    const footer = el('footer', { class: 'ed-footer' });
    this.hoverLine = el('span', { class: 'ed-hover' });
    this.status = el('span', { class: 'ed-status', role: 'status' });
    footer.append(this.hoverLine, this.status);
    this.root.appendChild(footer);

    this.refresh(true);
  }

  get level(): Level {
    return this.history.level;
  }

  get lint(): LintResult | null {
    return this.lintResult;
  }

  /** Start over on another level (a fresh history). */
  load(level: Level): void {
    this.history = new History(level);
    this.sel = new Set();
    this.refresh(true);
  }

  show(on: boolean): void {
    this.root.hidden = !on;
    if (on) {
      window.addEventListener('keydown', this.onKey);
      this.grid.redraw();
      this.iso.render();
    } else {
      window.removeEventListener('keydown', this.onKey);
    }
  }

  /** Apply an operation's result (the grid's strokes and clicks, the buttons). */
  commit(r: OpResult): void {
    if (r.changed) this.history.push(r.level);
    this.say(r.notice ?? '');
    if (r.changed) this.refresh(false);
  }

  /** An operation on the selection. */
  apply(op: (l: Level, s: ReadonlySet<number>) => OpResult): OpResult {
    const r = op(this.level, this.sel);
    this.commit(r);
    return r;
  }

  select(s: Set<number>): void {
    this.sel = s;
    this.grid.redraw();
    this.say(s.size > 0 ? `${s.size} cell${s.size > 1 ? 's' : ''} selected` : '');
  }

  get selection(): ReadonlySet<number> {
    return this.sel;
  }

  setTool(t: Tool): void {
    this.toolId = t;
    if (t === 'shape') this.advanced.open = true; // show the brush being painted with
    this.syncButtons();
    this.grid.redraw();
  }

  undo(): void {
    if (this.history.undo()) this.refresh(false);
  }

  redo(): void {
    if (this.history.redo()) this.refresh(false);
  }

  private op(f: (l: Level, s: ReadonlySet<number>) => OpResult): void {
    if (this.sel.size === 0) {
      this.say('select some cells first (Floor or Select)');
      return;
    }
    this.apply(f);
  }

  private raise(delta: 1 | -1): void {
    this.op((l, s) => raise(l, s, delta, this.slope ? 'slope' : 'cliff'));
  }

  private flatten(): void {
    this.op((l, s) => {
      const count = new Map<number, number>();
      for (const i of s) {
        const t = topOf(l.grid.shape[i], l.grid.elev[i]);
        if (t !== null) count.set(t, (count.get(t) ?? 0) + 1);
      }
      let top = 1;
      let n = -1;
      for (const [t, k] of count) if (k > n || (k === n && t > top)) [top, n] = [t, k];
      return flatten(l, s, top);
    });
  }

  private rename(name: string): void {
    const clean = cleanName(name);
    this.nameInput.value = clean;
    if (clean === this.level.name) return;
    this.history.push({ name: clean, grid: this.level.grid });
    this.refresh(false);
  }

  private newLevel(kind: string): void {
    if (!kind) return;
    let level: Level | null = null;
    if (kind === 'default') level = defaultLevel();
    else if (kind === 'empty') {
      const g = new HoleGrid(12, 10);
      g.rect(1, 1, 10, 8, { shape: 0x01, elev: 1 });
      g.fence();
      level = { name: 'NEW HOLE', grid: g };
    } else if (kind === 'random') {
      for (let k = 0; k < 20 && !level; k++) {
        const seed = 1 + Math.floor(Math.random() * 999_999);
        const b = buildHole(this.deps.rules, seed, 1, `RANDOM ${seed}`);
        if (b) level = { name: `RANDOM ${seed}`, grid: HoleGrid.fromJson(b.json) };
      }
    } else if (kind.startsWith('t')) {
      const t = this.deps.templates[Number(kind.slice(1))];
      if (t) level = { name: t.name, grid: HoleGrid.fromJson(t.json) };
    }
    if (!level) {
      this.say('could not make that level');
      return;
    }
    // a new level is one undo step away from the old one
    this.history.push(level);
    this.sel = new Set();
    this.refresh(true);
  }

  private play(): void {
    if (!this.lintResult?.ok) {
      this.say('fix the errors first (Checks)');
      return;
    }
    this.deps.onPlay(this.level);
  }

  private share(): void {
    if (!this.lintResult?.ok) {
      this.say('fix the errors first (Checks)');
      return;
    }
    this.deps.onShare(this.level);
  }

  say(text: string): void {
    this.status.textContent = text;
  }

  /** After any change: the lint now; the views, the par and the URL soon. */
  private refresh(fit: boolean): void {
    const level = this.level;
    this.lintResult = lintLevel(level, this.deps.rules);
    if (this.nameInput.value !== level.name) this.nameInput.value = level.name;
    // a selection that no longer fits the grid goes
    const n = level.grid.w * level.grid.h;
    for (const i of this.sel) if (i >= n) this.sel.delete(i);
    if (fit) this.grid.fit();
    this.grid.redraw();
    this.iso.schedule(level);
    this.sizeLine.textContent = `${level.grid.w} × ${level.grid.h} cells (${MIN_SIDE}-${MAX_SIDE})`;
    this.renderLint();
    this.syncButtons();
    this.scheduleSolve();
    this.deps.onChange(level);
  }

  private scheduleSolve(): void {
    clearTimeout(this.solveTimer);
    const lint = this.lintResult;
    if (!lint?.ok || !this.deps.solver) {
      this.solveState = { kind: lint?.ok ? 'idle' : 'blocked' };
      this.renderPar();
      return;
    }
    this.solveState = { kind: 'solving' };
    this.renderPar();
    const json = lint.json;
    const safe = lint.solverSafe;
    const seq = ++this.solveSeq;
    this.solveTimer = window.setTimeout(() => {
      void this.deps.solver!.solve(json).then((reply) => {
        if (!reply || seq !== this.solveSeq) return;
        this.solveState = { kind: 'done', reply, safe };
        this.renderPar();
        this.grid.redraw();
      });
    }, SOLVE_DELAY_MS);
  }

  /** A grid cell's centre on the page (window.__level, for the e2e test). */
  cellPoint(x: number, y: number): { x: number; y: number } {
    return this.grid.clientPoint(x, y);
  }

  /** The par line's state, for the e2e test (window.__level). */
  parState(): { kind: string; par?: number; ok?: boolean } {
    const s = this.solveState;
    return s.kind === 'done' ? { kind: s.kind, par: s.reply.par, ok: s.reply.ok } : { kind: s.kind };
  }

  private renderPar(): void {
    const s = this.solveState;
    const p = this.parLine;
    p.className = 'ed-par';
    if (s.kind === 'blocked') p.textContent = 'Fix the errors to get a par.';
    else if (s.kind === 'idle') p.textContent = 'No solver on this page.';
    else if (s.kind === 'solving') {
      p.textContent = 'Solving…';
      p.classList.add('ed-busy');
    } else if (s.reply.ok) {
      p.textContent = `Par ${s.reply.par}${s.safe ? '' : ' (unverified: tiles outside the palette)'}`;
      p.title = `The shortest plan the solver found (${s.reply.shots} shots tried; no spin, no A/Y).`;
      p.classList.add('ed-good');
    } else if (/budget/.test(s.reply.why)) {
      p.textContent = 'Couldn\'t prove it winnable within the solver\'s budget. It may still be.';
      p.title = s.reply.why;
      p.classList.add('ed-warn');
    } else {
      p.textContent = `Not winnable as far as the solver can tell: ${s.reply.why}.`;
      p.classList.add('ed-warn');
    }
  }

  private renderLint(): void {
    const ul = this.lintList;
    ul.replaceChildren();
    const issues = this.lintResult?.issues ?? [];
    if (issues.length === 0) {
      ul.appendChild(el('li', { class: 'ed-ok' }, 'No problems.'));
      return;
    }
    for (const issue of issues) {
      const li = el('li', { class: `ed-${issue.severity}` }, issue.message);
      if (issue.cells.length > 0) {
        li.classList.add('ed-link');
        li.title = 'Select these cells';
        li.addEventListener('click', () => this.select(new Set(issue.cells)));
      }
      ul.appendChild(li);
    }
  }

  private syncButtons(): void {
    for (const [t, b] of this.toolButtons) b.classList.toggle('ed-on', t === this.toolId);
    for (const [c, b] of this.paletteButtons) b.classList.toggle('ed-on', c === this.code);
    for (const [s, b] of this.shapeButtons) b.classList.toggle('ed-on', s === this.brush.shape);
    this.undoButton.disabled = !this.history.canUndo;
    this.redoButton.disabled = !this.history.canRedo;
    const ok = this.lintResult?.ok ?? false;
    this.playButton.disabled = !ok;
    this.shareButton.disabled = !ok;
  }

  private hover(c: { x: number; y: number } | null): void {
    if (!c) {
      this.hoverLine.textContent = '';
      return;
    }
    const g = (this.previewLevel ?? this.level).grid;
    const i = g.at(c.x, c.y);
    const s = g.shape[i];
    const parts = [`(${c.x}, ${c.y})`];
    if (s === 0) parts.push('gap');
    else {
      const corners = cornersOf(s, g.elev[i])!;
      parts.push(`$${hex(s)} ${shapeName(s)}`, `elevation ${g.elev[i]}`, `corners ${corners.join(' ')}`);
    }
    const t = g.tile[i];
    if (t) {
      const e = paletteEntry(t);
      parts.push(`tile $${hex(t)}${e ? ` ${isWaterTile(t) ? 'water' : e.label}` : ''}`);
    }
    const w = g.walls[i] & 0x0f;
    if (w) parts.push(`walls ${DIRS.filter((_, d) => w & (1 << d)).join('')}`);
    this.hoverLine.textContent = parts.join(' · ');
  }

  private key(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    let used = true;
    if (mod && k.toLowerCase() === 'z') {
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (mod && k.toLowerCase() === 'y') this.redo();
    else if (mod && k.toLowerCase() === 'a') this.select(allCells(this.level.grid));
    else if (mod) used = false;
    else if (k === '+' || k === '=') this.raise(1);
    else if (k === '-' || k === '_') this.raise(-1);
    else if (k === 'Delete' || k === 'Backspace') this.op((l, s) => dig(l, s));
    else if (k === 'f' || k === 'F') this.op((l, s) => fill(l, s));
    else if (k === 'b' || k === 'B') this.op((l, s) => blend(l, s));
    else if (k === 'p' || k === 'P') this.play();
    else if (k === 'Escape') this.select(new Set());
    else {
      const t = TOOLS.find((x) => x.key === k);
      if (t) this.setTool(t.id);
      else used = false;
    }
    if (used) e.preventDefault();
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, title?: string): HTMLButtonElement {
    const b = el('button', { type: 'button' }, label);
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    parent.appendChild(b);
    return b;
  }

  private tileIcon(code: number): HTMLCanvasElement {
    const c = el('canvas', { width: '28', height: '28' });
    const g = c.getContext('2d')!;
    g.fillStyle = heightColour(2);
    g.fillRect(0, 0, 28, 28);
    const t = code === WATER ? 0x61 : code;
    drawTileGlyph(g, t, 0, 0, 28, this.deps.sprites);
    return c;
  }

  private shapeIcon(s: number): HTMLCanvasElement {
    const c = el('canvas', { width: '24', height: '24' });
    const g = c.getContext('2d')!;
    const corners = cornersOf(s, 0)!;
    const mid = corners.reduce((a, b) => a + b, 0) / 4 + (s === 2 ? 0.5 : s === 3 ? -0.5 : 0);
    const pts: Array<[number, number]> = [[0, 0], [24, 0], [24, 24], [0, 24]];
    for (let q = 0; q < 4; q++) {
      const a = corners[q];
      const b = corners[(q + 1) & 3];
      g.fillStyle = heightColour((a + b + mid) * 2.2, 1);
      g.beginPath();
      g.moveTo(pts[q][0], pts[q][1]);
      g.lineTo(pts[(q + 1) & 3][0], pts[(q + 1) & 3][1]);
      g.lineTo(12, 12);
      g.closePath();
      g.fill();
    }
    return c;
  }
}

function hex(v: number): string {
  return v.toString(16).toUpperCase().padStart(2, '0');
}
