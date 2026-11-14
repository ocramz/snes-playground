import Phaser from 'phaser';
import { GAME_H, GAME_W } from '../config';
import { GameAudio } from '../audio/audio';
import { PadInput } from '../input';
import { ClipPlayer } from '../render/clips';
import { setFrame, spriteImage, UI, type AtlasJson } from '../render/atlas';
import { project, Z_STEP, type Proj } from '../render/projection';
import { GlyphText } from '../render/text';
import { ShotPanel, type UiJson } from '../render/shotpanel';
import { HoleSim, emptyPad, type Pad, type Stage } from '../sim/hole';
import { KirbyPose, type PoseCtx } from '../sim/pose';
import type { CourseJson, Rom } from '../sim/tables';

const STEP_MS = 1000 / 60.0988; // NTSC; every constant of the physics is per frame
const DEPTH_BACK = -1000;
/** Flat things on the ground (tee pad, cup): above the course, below everything that stands. */
const DEPTH_GROUND = DEPTH_BACK + 10;
const DEPTH_FRONT = 10000;
const DEPTH_UI = 20000;

interface LayersJson {
  backColour: number[];
  outline?: { stepFrames: number; cycle: number[][] };
  files: Record<string, number[]>;
}

interface EnemyView {
  img: Phaser.GameObjects.Image;
  clip: ClipPlayer;
  ring: Phaser.GameObjects.Image | null;
  mode: 'idle' | 'star' | 'cup';
  /** y-sort depth while it stands (the cell corner's y) */
  baseDepth: number;
}

const rgb = (c: number[]): number => Phaser.Display.Color.GetColor(c[0], c[1], c[2]);

export class HoleScene extends Phaser.Scene {
  sim!: HoleSim;
  private rom!: Rom;
  private course!: CourseJson;
  private atlas!: AtlasJson;
  private layers!: LayersJson;
  private pad!: PadInput;
  private audio!: GameAudio;

  private acc = 0;
  private freeze = 0;
  private tickCount = 0;
  private prevStage: Stage = 'aim';

  private kirby!: Phaser.GameObjects.Image;
  private kClip!: ClipPlayer;
  private pose = new KirbyPose();
  private shadow!: Phaser.GameObjects.Image;
  private enemies: EnemyView[] = [];
  private outline: Phaser.GameObjects.Image | null = null;
  private guideDots: Phaser.GameObjects.Image[] = [];
  private guideCone!: Phaser.GameObjects.Image;
  private ui!: UiJson;
  panel!: ShotPanel;
  private hudPanel!: Phaser.GameObjects.Image;
  private hint!: GlyphText;
  private hudHole!: GlyphText;
  private hudShot!: GlyphText;
  private hudStars!: GlyphText;
  private tomatoes: Phaser.GameObjects.Image[] = [];
  private toast!: GlyphText;
  private toastLeft = 0;
  private tmp: Proj = { x: 0, y: 0 };

  constructor() { super('Hole'); }

  create(): void {
    this.rom = this.registry.get('rom') as Rom;
    this.course = this.registry.get('course') as CourseJson;
    this.atlas = this.registry.get('atlas') as AtlasJson;
    this.layers = this.registry.get('layers') as LayersJson;
    this.audio = this.registry.get('audio') as GameAudio ?? new GameAudio();
    this.sim = new HoleSim(this.rom, this.course);
    this.pad = new PadInput(this);
    this.acc = 0; this.freeze = 0; this.tickCount = 0; this.enemies = []; this.guideDots = [];

    this.cameras.main.setBackgroundColor(rgb(this.layers.backColour));
    this.add.image(0, 0, 'layer_bg3').setOrigin(0, 0).setScrollFactor(0).setDepth(-2000);
    this.add.image(0, 0, 'layer_back').setOrigin(0, 0).setDepth(DEPTH_BACK);
    if (this.layers.files['layer_front.png']) {
      this.add.image(0, 0, 'layer_front').setOrigin(0, 0).setDepth(DEPTH_FRONT);
    }
    if (this.layers.files['layer_outline_front.png']) {
      this.outline = this.add.image(0, 0, 'layer_outline_front').setOrigin(0, 0).setDepth(DEPTH_FRONT + 1);
    }

    this.buildWorldSprites();
    this.buildUi();
    this.prevStage = 'aim';
    this.pose = new KirbyPose();
    this.pose.onStage('aim', 'aim', this.poseCtx(emptyPad()));
    this.kClip.play(this.pose.clip, true);
    this.pose.started();

    const k = this.input.keyboard!;
    k.on('keydown-R', () => this.restart());
    k.on('keydown-M', () => this.audio.setMuted(!this.audio.muted));
    this.cameras.main.setBounds(-1e6, -1e6, 2e6, 2e6);
    this.applyCamera();
    this.audio.playMusic();
    // ?debug exposes the scene to test/e2e scripts
    if (new URLSearchParams(location.search).has('debug')) (window as unknown as { __kdc: HoleScene }).__kdc = this;
  }

  // ---------------------------------------------------------------------
  // building
  // ---------------------------------------------------------------------

  private groundAt(col: number, row: number): number {
    const t = this.sim.terrain;
    const idx = row * t.w + col;
    const shape = t.shape[idx];
    if (!shape) return 0;
    return t.surface(shape, t.elev[idx], 0, 0x8000, 0x8000).z;
  }

  private cellCorner(col: number, row: number, out: Proj): Proj {
    return project(this.course.word7, col, 0, row, 0, this.groundAt(col, row), out);
  }

  private buildWorldSprites(): void {
    const c = this.course;
    // tee pad, at the cell centre
    if (c.tee) {
      const p = project(c.word7, c.tee.x, 0x8000, c.tee.y, 0x8000, this.groundAt(c.tee.x, c.tee.y));
      spriteImage(this, this.atlas, 'tee', p.x, p.y - 1).setDepth(DEPTH_GROUND);
    }
    // trees: the thread objects of type 72, at the corner of their cell
    for (const o of c.objects) {
      const p = this.cellCorner(o.x, o.y, { x: 0, y: 0 });
      spriteImage(this, this.atlas, 'tree', p.x, p.y).setDepth(p.y);
    }
    for (const e of this.sim.enemies) {
      const p = this.cellCorner(e.col, e.row, { x: 0, y: 0 });
      const img = spriteImage(this, this.atlas, 'enemy_0', p.x, p.y).setDepth(p.y);
      const clip = new ClipPlayer(this.atlas);
      clip.play('enemy_idle');
      this.enemies.push({ img, clip, ring: null, mode: 'idle', baseDepth: p.y });
    }
    this.shadow = spriteImage(this, this.atlas, 'shadow', 0, 0).setVisible(false);
    this.kirby = spriteImage(this, this.atlas, 'k_' + this.firstKirbyFrame(), 0, 0);
    this.kClip = new ClipPlayer(this.atlas);
    this.ui = this.registry.get('ui') as UiJson;
    for (let i = 0; i < 12; i++) {
      this.guideDots.push(this.add.image(0, 0, UI, this.ui.guide.dot).setOrigin(0, 0).setVisible(false).setDepth(DEPTH_FRONT + 5));
    }
    this.guideCone = this.add.image(0, 0, UI, this.ui.guide.cone).setOrigin(0, 0).setVisible(false).setDepth(DEPTH_FRONT + 6);
  }

  private firstKirbyFrame(): string {
    const name = Object.keys(this.atlas.frames).find((n) => n.startsWith('k_')) ?? 'k_0';
    return name.slice(2);
  }

  private buildUi(): void {
    this.panel = new ShotPanel(this, this.registry.get('ui') as UiJson, DEPTH_UI + 1);
    this.hudPanel = this.add.image(16, 176, 'hud_panel').setOrigin(0, 0).setScrollFactor(0).setDepth(DEPTH_UI + 1);
    this.hudHole = new GlyphText(this, 112, 191, '1', 2, 0xd6a0ff).setScrollFactor(0).setDepth(DEPTH_UI + 2);
    this.hudShot = new GlyphText(this, 137, 197, '00', 1, 0x2a2a2a).setScrollFactor(0).setDepth(DEPTH_UI + 2);
    this.hudStars = new GlyphText(this, 200, 200, '00', 1, 0xffbd6b).setScrollFactor(0).setDepth(DEPTH_UI + 2);
    for (let i = 0; i < 4; i++) {
      this.tomatoes.push(this.add.image(164 + 16 * i, 183, 'hud_tomato').setOrigin(0, 0).setScrollFactor(0).setDepth(DEPTH_UI + 2));
    }
    this.hint = new GlyphText(this, 4, 4, '', 1, 0xffffff).setScrollFactor(0).setDepth(DEPTH_UI + 3);
    this.toast = new GlyphText(this, 0, 52, '', 2, 0xffe27a).setScrollFactor(0).setDepth(DEPTH_UI + 3);
  }

  private restart(): void {
    this.sim.restart();
    for (const v of this.enemies) {
      v.mode = 'idle'; v.clip.play('enemy_idle', true); v.ring?.destroy(); v.ring = null;
      v.img.setDepth(v.baseDepth);
    }
    this.freeze = 0;
    this.applyCamera();
    this.prevStage = 'aim';
    this.pose = new KirbyPose();
    this.pose.onStage('aim', 'aim', this.poseCtx(emptyPad()));
  }

  // ---------------------------------------------------------------------
  // the loop
  // ---------------------------------------------------------------------

  update(_time: number, delta: number): void {
    this.acc = Math.min(this.acc + delta, STEP_MS * 5); // never spiral after a stall
    while (this.acc >= STEP_MS) {
      this.acc -= STEP_MS;
      this.stepOnce(this.pad.sample());
    }
    this.render();
  }

  private stepOnce(pad: Pad): void {
    this.tickCount += 1;
    if (this.freeze > 0) {
      // the game waits a few frames on a hard landing; only the squash shows
      this.freeze -= 1;
      this.animate(pad);
      return;
    }
    const before = this.sim.stage;
    this.sim.tick(pad);
    this.handleEvents();
    if (this.sim.ball.hitStop > 0 && this.sim.stage === 'roll') this.freeze = this.sim.ball.hitStop;
    this.animate(pad);
    void before;
  }

  private handleEvents(): void {
    for (const ev of this.sim.events) {
      switch (ev.type) {
        case 'sfx': this.audio.sfx(ev.id); break;
        case 'enemy': this.onEnemy(ev.index); break;
        case 'cup': this.onCup(ev.index); break;
        case 'hop': this.pose.onHop(ev.air); break;
        case 'stage': this.onStage(ev.stage); break;
        default: break;
      }
    }
  }

  private onEnemy(index: number): void {
    const v = this.enemies[index];
    v.mode = 'star';
    v.clip.play('star', true);
    this.showToast(['NICE!', 'GREAT!', ''][Math.min(this.sim.stars - 1, 2)]);
  }

  private onCup(index: number): void {
    const v = this.enemies[index];
    v.mode = 'cup';
    v.clip.play('cup_open', true);
    const e = this.sim.enemies[index];
    const p = this.cellCorner(e.col, e.row, { x: 0, y: 0 });
    // the cup is a flat picture on the floor: it must stay under Kirby wherever he is
    // in the cell (y-sorting at the cell's middle line put it over him)
    v.img.setDepth(DEPTH_GROUND + 1);
    v.ring = spriteImage(this, this.atlas, 'cupring', p.x, p.y).setDepth(DEPTH_GROUND + 2);
    this.showToast('THE CUP!');
  }

  private onStage(s: Stage): void {
    this.pose.onStage(s, this.prevStage, this.poseCtx(emptyPad()));
    if (s === 'sink') { this.audio.stopMusic(); this.audio.jingle(); }
    if (s === 'done' || s === 'fail') {
      this.time.delayedCall(700, () => {
        this.scene.start('Result', { won: s === 'done', strokes: this.sim.strokes, stars: this.sim.stars });
      });
    }
    if (s === 'lost') this.showToast('OUT!');
    this.prevStage = s;
  }

  private showToast(text: string): void {
    if (!text) return;
    this.toast.setText(text);
    this.toast.x = Math.round((GAME_W - this.toast.width8) / 2);
    this.toastLeft = 90;
  }

  // ---------------------------------------------------------------------
  // animation per tick (60 Hz)
  // ---------------------------------------------------------------------

  private poseCtx(pad: Pad): PoseCtx {
    const sim = this.sim;
    return {
      stage: sim.stage, facing: sim.facing, angle16: sim.shotAngle16,
      turning: pad.left || pad.right,
      frozen: this.freeze > 0, squash: sim.ball.squash,
      hp: sim.hp, side: sim.side, topBack: sim.topBack, shotAge: sim.shotAge, curlStarted: sim.curlStarted,
      clipFinished: this.kClip.finished,
    };
  }

  private animate(pad: Pad): void {
    this.pose.tick(this.poseCtx(pad));
    this.kClip.play(this.pose.clip, this.pose.restart);
    this.pose.started();
    this.kClip.tick();
    for (const v of this.enemies) {
      v.clip.tick();
      const fr = v.clip.frame;
      if (fr) setFrame(v.img, this.atlas, fr);
    }
    if (this.outline) {
      const o = this.layers.outline!;
      const i = Math.floor(this.tickCount / o.stepFrames) % o.cycle.length;
      const c = o.cycle[i];
      this.outline.setTint(Phaser.Display.Color.GetColor(c[0], c[1], c[2]));
    }
    if (this.toastLeft > 0) {
      this.toastLeft -= 1;
      if (this.toastLeft === 0) this.toast.setText('');
    }
  }

  // ---------------------------------------------------------------------
  // drawing
  // ---------------------------------------------------------------------

  private render(): void {
    const sim = this.sim;
    const b = sim.ball;
    const w = this.course.word7;

    // Kirby and his shadow
    const ground = b.cur.shape ? b.cur.ground : 0;
    const gp = project(w, b.xc, b.xf, b.yc, b.yf, ground, this.tmp);
    const gx = gp.x, gy = gp.y;
    const bp = project(w, b.xc, b.xf, b.yc, b.yf, b.z, this.tmp);
    const hidden = sim.stage === 'lost' || sim.stage === 'done' || sim.stage === 'fail';
    const fr = this.kClip.frame;
    this.kirby.setVisible(!hidden && !!fr);
    if (fr) setFrame(this.kirby, this.atlas, fr);
    // the ball sprite sits 2 px above the projected point (measured)
    this.kirby.setPosition(Math.round(bp.x), Math.round(bp.y - 2));
    this.kirby.setDepth(gy + 0.5);
    this.shadow.setVisible(!hidden && b.air && b.z > ground + 0x1000);
    this.shadow.setPosition(Math.round(gx), Math.round(gy));
    this.shadow.setDepth(gy);

    // cup ring follows the enemy view depth already; nothing else moves

    this.applyCamera();
    this.drawGuide();
    this.drawUi();
  }

  /** The game's camera (src/sim/camera.ts) becomes the scroll. */
  private applyCamera(): void {
    const c = this.sim.camera;
    this.cameras.main.setScroll(Math.round(c.scrollX), Math.round(c.scrollY));
  }

  /**
   * The guide of the aim stage: dots marching along the predicted path (full power, see
   * src/sim/guide.ts) and the cone where it ends. Measured on the real game: the dots are
   * 0.86 cells apart and move outward, one spacing in 20 frames; the dot's 8x8 centre is at
   * the path point + (-3, 0), the cone's top-left at the end + (-6, -15).
   */
  private drawGuide(): void {
    const g = this.sim.stage === 'aim' ? this.sim.guide : null;
    if (!g) {
      for (const d of this.guideDots) d.setVisible(false);
      this.guideCone.setVisible(false);
      return;
    }
    const pts = g.points;
    const total = g.end.d;
    const SPACING = 0.86;
    let j = 0;
    const phase = (this.tickCount % 20) / 20;
    for (let k = 0; k < this.guideDots.length; k++) {
      const dist = (phase + k) * SPACING;
      if (dist > total) { this.guideDots[k].setVisible(false); continue; }
      while (j + 1 < pts.length - 1 && pts[j + 1].d < dist) j += 1;
      const a = pts[j], b = pts[Math.min(j + 1, pts.length - 1)];
      const f = b.d > a.d ? (dist - a.d) / (b.d - a.d) : 0;
      const x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
      this.guideDots[k].setVisible(true).setPosition(Math.round(x - 7), Math.round(y - 4));
    }
    this.guideCone.setVisible(true).setPosition(Math.round(g.end.x - 6), Math.round(g.end.y - 15));
  }

  private drawUi(): void {
    const sim = this.sim;
    // while the spin and the power are chosen the game replaces its score panel by the
    // shot panel with its own row of tomatoes (docs/web-demo.md)
    const shotUi = sim.stage === 'spin' || sim.stage === 'power' || sim.stage === 'curl';
    this.hudPanel.setVisible(!shotUi);
    this.hudHole.setVisible(!shotUi); this.hudShot.setVisible(!shotUi); this.hudStars.setVisible(!shotUi);
    this.hudHole.setText('1');
    this.hudShot.setText(String(sim.strokes).padStart(2, '0'));
    this.hudStars.setText(String(sim.stars).padStart(2, '0'));
    this.tomatoes.forEach((t, i) => {
      t.setVisible(!shotUi);
      if (i < sim.hp) t.clearTint().setAlpha(1);
      else t.setTint(0x404040).setAlpha(0.55);
    });

    const hint: Record<string, string> = {
      aim: 'LR AIM  U FLY  D ROLL  A OK',
      spin: 'LR SPIN  A OK  B BACK',
      power: 'A = SHOOT  B BACK',
      roll: 'A HOP  S BRAKE',
    };
    this.hint.setText(hint[sim.stage] ?? '');

    const cam = this.cameras.main;
    const b = sim.ball;
    const bp = project(this.course.word7, b.xc, b.xf, b.yc, b.yf, b.z, this.tmp);
    this.panel.update({
      x: bp.x - cam.scrollX, y: bp.y - cam.scrollY, age: sim.shotAge, visible: shotUi,
      side: sim.side, topBack: sim.topBack,
      meter1: shotUi && sim.stage !== 'spin' ? sim.meter1 : -1, meter2: shotUi && sim.stage !== 'spin' ? sim.meter2 : -1,
      hp: sim.hp,
    });
    void GAME_H;
    void Z_STEP;
  }
}
