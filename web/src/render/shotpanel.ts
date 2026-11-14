// The panel the game draws while the spin and the power are chosen: a "1" above
// Kirby that bobs, a face with a vertical ruler and a marker, a gauge and a row
// of tomatoes. Every picture and offset was read from the real game's sprites
// (tools/export_web_ui.py), anchored to Kirby's ball point on the screen.
import Phaser from 'phaser';
import { UI } from './atlas';

interface Pic { f: string; x: number; y: number; t?: number }
export interface UiJson {
  image: string;
  size: [number, number];
  frames: Record<string, { x: number; y: number; w: number; h: number }>;
  base: Pic[];
  face: Pic[];
  one: { f: string; x: number; dy: number }[];
  tomato: Pic[];
  ruler: { f: string; dx: number; y: number }[];
  bar: { f: string; dx: number };
  dot: { f: string; dx: number };
  guide: { dot: string; cone: string };
  gauge: Record<string, Pic[]>;
  faces: Record<string, Pic[]>;
  timing: {
    one: number; panel: number; ready: number; slide: number[]; meterStart: number;
    oneIntro: [number, number][]; oneCycle: { from: number; frames: number; values: number[] };
  };
}

/** The tiles of the gauge frame that slide in when the panel opens. */
const SLIDING = new Set([50, 52, 54, 66, 67]);

export interface PanelState {
  /** Kirby's ball point on the screen */
  x: number;
  y: number;
  /** frames since the A that confirmed the aim */
  age: number;
  visible: boolean;
  side: number;
  topBack: number;
  /** the power meter one and two ticks ago (the game draws the gauge one frame and the face two behind), or -1 */
  meter1: number;
  meter2: number;
  hp: number;
}

export class ShotPanel {
  readonly root: Phaser.GameObjects.Container;
  private readonly one: Phaser.GameObjects.Image[] = [];
  private readonly base: { img: Phaser.GameObjects.Image; p: Pic }[] = [];
  private readonly ruler: { img: Phaser.GameObjects.Image; y: number }[] = [];
  private readonly bar: Phaser.GameObjects.Image;
  private readonly dot: Phaser.GameObjects.Image;
  private readonly tomato: Phaser.GameObjects.Image[] = [];
  private readonly gauge: Phaser.GameObjects.Image[] = [];
  private readonly face: Phaser.GameObjects.Image[] = [];

  constructor(scene: Phaser.Scene, private readonly ui: UiJson, depth: number) {
    this.root = scene.add.container(0, 0).setScrollFactor(0).setDepth(depth).setVisible(false);
    const add = (f: string): Phaser.GameObjects.Image => {
      const img = scene.add.image(0, 0, UI, f).setOrigin(0, 0);
      this.root.add(img);
      return img;
    };
    for (const p of ui.face) this.face.push(add(p.f));
    for (const p of ui.base) this.base.push({ img: add(p.f), p });
    for (const r of ui.ruler) this.ruler.push({ img: add(r.f), y: r.y });
    this.bar = add(ui.bar.f);
    this.dot = add(ui.dot.f);
    for (const o of ui.one) this.one.push(add(o.f));
    for (const t of ui.tomato) this.tomato.push(add(t.f));
    for (let i = 0; i < 4; i++) this.gauge.push(add(ui.base[0].f).setVisible(false));
  }

  update(s: PanelState): void {
    const t = this.ui.timing;
    const showOne = s.visible && s.age >= t.one;
    const showPanel = s.visible && s.age >= t.panel;
    this.root.setVisible(showOne);
    if (!showOne) return;
    this.root.setPosition(Math.round(s.x), Math.round(s.y));

    const bob = this.bob(s.age);
    this.ui.one.forEach((o, i) => this.one[i].setPosition(o.x, bob + o.dy));

    const slide = t.slide[Math.min(t.slide.length - 1, Math.max(0, s.age - t.panel))];
    for (const { img, p } of this.base) {
      img.setVisible(showPanel).setPosition(p.x + (SLIDING.has(p.t ?? -1) ? slide : 0), p.y);
    }
    const sx = -4 + 2 * (s.side - 6);
    for (const r of this.ruler) r.img.setVisible(showPanel).setPosition(sx + 0, r.y);
    this.bar.setVisible(showPanel).setPosition(sx + this.ui.bar.dx, 24);
    this.dot.setVisible(showPanel).setPosition(sx + this.ui.dot.dx, 24 + 2 * (s.topBack - 6));
    this.ui.tomato.forEach((p, i) => {
      const img = this.tomato[i].setVisible(showPanel).setPosition(p.x, p.y);
      if (i < s.hp) img.clearTint().setAlpha(1);
      else img.setTint(0x404040).setAlpha(0.55);
    });

    // the face fills with red and the gauge rises with the meter; at 0 it is the plain face
    const face = (s.meter2 >= 1 ? this.ui.faces[String(Math.min(63, s.meter2))] : undefined) ?? this.ui.face;
    this.face.forEach((img, i) => img.setVisible(showPanel).setTexture(UI, face[i].f).setPosition(face[i].x, face[i].y));
    const gauge = (s.meter1 >= 1 ? this.ui.gauge[String(Math.min(63, s.meter1))] : undefined) ?? [];
    this.gauge.forEach((img, i) => {
      const p = gauge[i];
      if (p && showPanel) img.setTexture(UI, p.f).setVisible(true).setPosition(p.x, p.y);
      else img.setVisible(false);
    });
  }

  /** The height of the "1" above Kirby, as the game bobs it. */
  private bob(age: number): number {
    const t = this.ui.timing;
    if (age >= t.oneCycle.from) {
      const c = t.oneCycle;
      return c.values[Math.floor((age - c.from) / c.frames) % c.values.length];
    }
    let y = t.oneIntro[0][1];
    for (const [from, v] of t.oneIntro) if (age >= from) y = v;
    return y;
  }

  hide(): void { this.root.setVisible(false); }
}
