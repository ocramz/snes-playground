/**
 * The shot panel's sprites for one state (pure): the real game's OBJ
 * pictures and offsets from tools/export_web_ui.py (ui.json), anchored to
 * Kirby's point on the screen. tools/check_web_ui.py compares the result
 * with the game's own OAM, pixel for pixel, above the tomato row.
 *
 * Measured on web_ui (ages from the A that confirms the aim, 2800):
 * - the "1": from +46, its top tile at the bob height and the other 8 below;
 *   -40 from +46, -39 from +54, then from +70 the 32-frame cycle
 *   -38 -39 -40 -39;
 * - the panel from +66: the gauge frame (`base`) slides in over 4 frames;
 * - the ruler and the marker at x = -4 + 2 (side - 6); the bar at y 24 and
 *   the dot at 24 + 2 (topBack - 6);
 * - the gauge shows the meter one frame old, the face two frames old (the
 *   static face without a meter);
 * - tomatoes at (-24 + 16 k, 53), one per tomato; the one about to be spent
 *   blinks in the power stage, 8 frames off, 8 on, in phase with the curl
 *   (web_ui 3242-3249 off, 3250-3257 on; measured 2026-11-14, a stepper run
 *   with snapshots 3240-3281).
 *
 * Back to front, as the OAM orders them (a lower index is drawn in front;
 * web_ui f003180): the face, the gauge frame, the ruler, the bar, the dot,
 * the gauge, the tomatoes, the "1".
 */
import type { UiJson, UiPart } from '../../assets/schema';

export interface PanelInput {
  /** Kirby's point on the screen. */
  x: number;
  y: number;
  /** Frames since the aim's A (see panel-state.ts). */
  age: number;
  visible: boolean;
  side: number;
  topBack: number;
  /** The meter one and two frames ago, -1 when none. */
  meter1: number;
  meter2: number;
  /** Tomatoes. */
  hp: number;
  /** The panel (face, gauge, ruler, tomatoes) is still up: false after the roll starts. */
  panel?: boolean;
  /** The "1" is still up: false a few frames after the roll starts. */
  one?: boolean;
  /** The tomato about to be spent is in its off phase. */
  blinkOff?: boolean;
  /**
   * The spin preset's panel (B held in the aim): the face, the ruler at the
   * side and the bar at the top/back (web_bspin 2620: tile 58 at y 24 +
   * 2 (topBack - 6)); no gauge frame, gauge, tomatoes or "1".
   */
  preset?: boolean;
}

export interface PanelSprite {
  /** ui.json frame name. */
  f: string;
  /** Screen top-left. */
  x: number;
  y: number;
}

export function oneBob(ui: UiJson, age: number): number | null {
  const t = ui.timing;
  if (age < t.one) return null;
  if (age >= t.oneCycle.from) {
    const v = t.oneCycle.values;
    return v[Math.floor((age - t.oneCycle.from) / t.oneCycle.frames) % v.length];
  }
  let bob: number | null = null;
  for (const [from, y] of t.oneIntro) if (age >= from) bob = y;
  return bob;
}

export function panelSprites(ui: UiJson, s: PanelInput): PanelSprite[] {
  if (!s.visible) return [];
  const out: PanelSprite[] = [];
  const put = (p: UiPart, x: number, y: number): void => {
    out.push({ f: p.f, x: s.x + x, y: s.y + y });
  };
  const t = ui.timing;
  if (s.preset) {
    const pr = ui.preset;
    const sx = -4 + 2 * (s.side - 6);
    const ty = 2 * (s.topBack - 6);
    if (pr) {
      for (const p of pr.face) put(p, p.x ?? 0, p.y ?? 0);
      for (const p of pr.ruler) put(p, sx + (p.dx ?? 0), p.y ?? 0);
      put(pr.bar, sx + (pr.bar.dx ?? 0), (pr.bar.dy ?? 24) + ty);
    } else {
      for (const p of ui.face) put(p, p.x ?? 0, p.y ?? 0);
      for (const p of ui.ruler) put(p, sx + (p.dx ?? 0), p.y ?? 0);
      put(ui.bar, sx + (ui.bar.dx ?? 0), 24 + ty);
    }
    return out;
  }
  const panelUp = (s.panel ?? true) && s.age >= t.panel;
  if (panelUp) {
    const face = s.meter2 >= 0 ? ui.faces[String(s.meter2)] ?? ui.face : ui.face;
    for (const p of face) put(p, p.x ?? 0, p.y ?? 0);
    const k = s.age - t.panel;
    const slide = k < t.slide.length ? t.slide[k] : 0;
    for (const p of ui.base) put(p, (p.x ?? 0) + slide, p.y ?? 0);
    const sx = -4 + 2 * (s.side - 6);
    for (const p of ui.ruler) put(p, sx + (p.dx ?? 0), p.y ?? 0);
    put(ui.bar, sx + (ui.bar.dx ?? 0), 24);
    put(ui.dot, sx + (ui.dot.dx ?? 0), 24 + 2 * (s.topBack - 6));
    if (s.meter1 >= 0) for (const p of ui.gauge[String(s.meter1)] ?? []) put(p, p.x ?? 0, p.y ?? 0);
    const n = Math.max(0, Math.min(ui.tomato.length, s.hp));
    for (let i = 0; i < n; i++) {
      if (i === n - 1 && s.blinkOff) continue;
      const p = ui.tomato[i];
      put(p, p.x ?? 0, p.y ?? 0);
    }
  }
  const bob = (s.one ?? true) ? oneBob(ui, s.age) : null;
  if (bob !== null) for (const p of ui.one) put(p, p.x ?? 0, bob + (p.dy ?? 0));
  return out;
}

/** Every ui.json frame the layout can name (for the catalog test). */
export function panelFrames(ui: UiJson): Set<string> {
  const names = new Set<string>();
  const add = (p: UiPart): void => void names.add(p.f);
  [...ui.face, ...ui.base, ...ui.ruler, ui.bar, ui.dot, ...ui.tomato, ...ui.one].forEach(add);
  if (ui.preset) [...ui.preset.face, ...ui.preset.ruler, ui.preset.bar].forEach(add);
  for (const list of Object.values(ui.gauge)) list.forEach(add);
  for (const list of Object.values(ui.faces)) list.forEach(add);
  names.add(ui.guide.dot);
  names.add(ui.guide.cone);
  return names;
}
