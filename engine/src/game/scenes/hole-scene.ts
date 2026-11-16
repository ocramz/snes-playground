/**
 * The simulation host (reference §7: the only scene that runs core
 * systems). One run per hole: HoleOver restarts it with `advance`, and its
 * `create` calls `nextHole`; the hole's entities are core's to tear down
 * (startHole / endGame destroy the IsHole roots), the views are released on
 * SHUTDOWN.
 *
 * update(time, delta) (plans "HoleScene.update"):
 *   1. tick-time: N <= 4 core frames at 60.0988 Hz;
 *   2. per core frame: the cutscene director may hold the core (the intro),
 *      else capture-input -> Pad.raw, runCoreFrame; the history samples;
 *   3. once: the events (drained once, plus the cutscene's cues), then the
 *      presentation schedule (bridge/schedule.ts);
 *   4. the flow's hand-offs: HoleOver -> the next hole, CourseDone and
 *      GameOver -> the result scene.
 * Esc / P pause and resume (the `pause` action: IsPaused, the views keep
 * drawing); losing focus pauses until it comes back.
 */
import Phaser from 'phaser';
import type { World } from 'koota';
import { SceneKeys } from '../scene-keys';
import { nextHole, pause, resume, placeBall, endGame, type BallPlacement } from '../../core/actions';
import { AimUi, ScorePanel } from '../../core/traits/aim-ui';
import { Shot } from '../../core/traits/shot';
import { Camera } from '../../core/traits/camera';
import { Screen } from '../../core/traits/screen';
import { Career } from '../../core/traits/counters';
import { HoleFlow } from '../../core/traits/flow';
import { Session, IsPaused } from '../../core/traits/session';
import { Course, courseEntity, type CourseState } from '../../core/traits/course';
import { Cell, IsCup } from '../../core/traits/hole';
import { Time } from '../../core/traits/time';
import { Warp } from '../../core/traits/warp';
import { Switches } from '../../core/traits/switches';
import { BallWork } from '../../core/traits/ball';
import { findActivePlayer } from '../../core/traits/player';
import { Pad } from '../../core/traits/pad';
import { runCoreFrame } from '../../core/schedule';
import { FrameClock } from '../bridge/tick-time';
import { CoreHistory } from '../bridge/history';
import { runHostFrame } from '../bridge/frame-loop';
import { Controls } from '../bridge/capture-input';
import { Disposables } from '../bridge/disposables';
import { ViewRegistry } from '../bridge/view-registry';
import { primeBindings } from '../bridge/bind-views';
import { runPresentation } from '../bridge/schedule';
import { CupMaskClock } from '../features/enemies/cup-mask';
import { drainEvents } from '../../core/events';
import { DEPTH, type Presentation } from '../bridge/presentation';
import { cellCorner, teePad } from '../bridge/placement';
import type { ViewCtx } from '../bridge/view';
import { VIEW_CATALOG } from '../features/view-catalog';
import { LayersView } from '../features/layers/layers-view';
import { GuideView } from '../features/guide/guide-view';
import { PanelView } from '../features/shot-panel/panel-view';
import { CutsceneView } from '../features/cutscene/cutscene-view';
import { WarpView } from '../features/warp/warp-view';
import { SnapStarsView } from '../features/env/snap-stars-view';
import { WaterFxView } from '../features/env/water-fx-view';
import { AbilityFxView } from '../features/env/ability-fx-view';
import { CutsceneDirector } from '../features/cutscene/director';
import type { Anchors } from '../features/cutscene/replay';
import { hudHidden, pauseState, lookArrowsState } from '../features/hud/hud-state';
import { AimUiView } from '../features/hud/aim-ui-view';
import { CardView } from '../features/card/card-view';
import { cardState } from '../features/card/card-state';
import { KirbyView } from '../features/kirby/kirby-view';
import type { HoleAssets } from '../assets/course-sets';
import type { Host } from '../host';
import { addText } from '../features/text/font';
import { freeEnemies, hitNextEnemy, putOnCup } from '../debug';

export interface HoleData {
  host: Host;
  /** Go on to the next hole first (the previous run ended in HoleOver). */
  advance?: boolean;
}

export class HoleScene extends Phaser.Scene {
  private host!: Host;
  private advance = false;
  private leaving = false;
  private frozen = false;
  private pausedByBlur = false;
  private readonly clock = new FrameClock();
  private readonly history = new CoreHistory();
  private disposables!: Disposables;
  private controls!: Controls;
  private views!: ViewRegistry;
  private director!: CutsceneDirector;
  private p!: Presentation;
  private pausedLabel: Phaser.GameObjects.BitmapText | Phaser.GameObjects.Text | null = null;
  private aimUi!: AimUiView;
  private card!: CardView;

  constructor() {
    super(SceneKeys.Hole);
  }

  init(data: HoleData): void {
    this.host = data.host;
    this.advance = data.advance ?? false;
    this.leaving = false;
    this.frozen = false;
    this.pausedByBlur = false;
    this.clock.reset();
    this.history.reset();
    this.disposables = new Disposables();
  }

  create(): void {
    const host = this.host;
    const world = host.world;
    const rules = host.rules!;
    if (this.advance && nextHole(world) === null) {
      this.leaving = true;
      this.scene.start(SceneKeys.Result, { host, mode: 'course' });
      return;
    }
    const hole = this.holeAssets(world);
    const course = courseEntity(world).get(Course)!;
    const layers = new LayersView(
      this, rules, course, hole?.layersOf ?? null, hole?.layers ?? null, host.flags.debug, host.assets.terrainStyle,
    );
    this.views = new ViewRegistry(this, host, VIEW_CATALOG);
    primeBindings(world);
    this.director = new CutsceneDirector(host.assets.cutscenes, () => this.anchors(world, course));
    const song = hole?.data.song;
    if (host.flags.nointro || !this.director.startIntro(song)) host.audio?.playSong(song ?? 0);
    this.controls = new Controls(this.input.keyboard);
    this.disposables.add(() => this.controls.dispose());
    this.p = {
      ctx: this.viewCtx(world, course),
      views: this.views,
      layers,
      guide: new GuideView(this, host.assets.ui, DEPTH.guide),
      panel: new PanelView(this, host.assets.ui, DEPTH.panel),
      cutscene: new CutsceneView(this, { ground: DEPTH.decal - 1, sprites: DEPTH.cutsceneSprites, fade: DEPTH.fade }),
      warp: new WarpView(this, DEPTH.actor),
      snapStars: new SnapStarsView(this, DEPTH.actor),
      waterFx: new WaterFxView(this, DEPTH.actor),
      abilityFx: new AbilityFxView(this, DEPTH.actor),
      director: this.director,
      audio: host.audio,
      camera: this.cameras.main,
      events: [],
      cupMask: new CupMaskClock(),
      groundOver: null,
    };
    this.bindKeys(world, layers);
    this.bindFocus(world);
    if (!this.scene.isActive(SceneKeys.Hud)) this.scene.launch(SceneKeys.Hud, { host });
    this.scene.bringToTop(SceneKeys.Hud);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.disposables.dispose();
      this.views.releaseAll();
      if (host.flags.debug) delete (window as unknown as { __engine?: unknown }).__engine;
    });
    this.aimUi = new AimUiView(this, host.assets.hud, DEPTH.panel + 50);
    this.disposables.add(() => this.aimUi.destroy());
    // the per-hole RESULT card ($83:D3ED): the hole's scenery, its course's window
    const rom = hole?.layersOf ?? null;
    this.card = new CardView(
      this, host.assets.card, rom, rom === null ? 1 : Math.floor(rom / 8) % 8 + 1, DEPTH.fade - 20, hole?.layers?.backColour,
    );
    this.disposables.add(() => this.card.destroy());
    if (host.flags.debug) this.exposeDebug(world);
  }

  private holeAssets(world: World): HoleAssets | null {
    const i = world.get(Session)!.holeIndex;
    return this.host.set?.holes[i] ?? null;
  }

  private anchors(world: World, course: CourseState): Anchors | null {
    const rules = this.host.rules;
    if (!rules) return null;
    const cup = world.queryFirst(IsCup);
    const cell = cup?.get(Cell);
    return {
      tee: teePad(rules, course),
      cup: cell ? cellCorner(rules, course, cell.x, cell.y) : teePad(rules, course),
    };
  }

  private viewCtx(world: World, course: CourseState): ViewCtx {
    return {
      scene: this,
      world,
      host: this.host,
      rules: this.host.rules!,
      course,
      history: this.history,
      frame: world.get(Time)!.frame,
      hidden: this.director.hidden(),
    };
  }

  private bindKeys(world: World, layers: LayersView): void {
    const kb = this.input.keyboard;
    if (!kb) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.code === 'Escape' || ev.code === 'KeyP') this.togglePause(world);
      else if (ev.code === 'KeyD' && this.host.flags.debug) layers.toggleTerrain();
    };
    kb.on(Phaser.Input.Keyboard.Events.ANY_KEY_DOWN, onKey);
    this.disposables.add(() => kb.off(Phaser.Input.Keyboard.Events.ANY_KEY_DOWN, onKey));
  }

  private bindFocus(world: World): void {
    const lose = (): void => {
      this.controls.clear();
      if (!world.has(IsPaused)) {
        pause(world);
        this.pausedByBlur = true;
        this.showPaused(true);
      }
    };
    const gain = (): void => {
      if (this.pausedByBlur && world.has(IsPaused)) {
        resume(world);
        this.showPaused(false);
      }
      this.pausedByBlur = false;
      this.clock.reset();
    };
    const events = this.game.events;
    events.on(Phaser.Core.Events.BLUR, lose);
    events.on(Phaser.Core.Events.HIDDEN, lose);
    events.on(Phaser.Core.Events.FOCUS, gain);
    events.on(Phaser.Core.Events.VISIBLE, gain);
    this.disposables.add(() => {
      events.off(Phaser.Core.Events.BLUR, lose);
      events.off(Phaser.Core.Events.HIDDEN, lose);
      events.off(Phaser.Core.Events.FOCUS, gain);
      events.off(Phaser.Core.Events.VISIBLE, gain);
    });
  }

  private togglePause(world: World): void {
    if (world.has(IsPaused)) resume(world);
    else pause(world);
    this.pausedByBlur = false;
    this.showPaused(world.has(IsPaused));
  }

  private showPaused(on: boolean): void {
    if (on && !this.pausedLabel) this.pausedLabel = addText(this, 108, 104, 'PAUSE').setDepth(DEPTH.fade + 1);
    this.pausedLabel?.setVisible(on);
  }

  update(_time: number, delta: number): void {
    if (this.leaving || this.frozen) return;
    const world = this.host.world;
    const n = this.clock.step(delta);
    this.p.events = runHostFrame(world, n, {
      readPad: () => this.controls.read(),
      history: this.history,
      beforeTick: (w) => this.director.beforeTick(w),
      afterTick: (w, ran) => this.director.afterTick(w, ran),
      takeCues: () => this.director.takeCues(),
    });
    this.present(world);
    this.handOff(world);
  }

  private present(world: World): void {
    this.p.ctx.frame = world.get(Time)!.frame;
    this.p.ctx.hidden = this.director.hidden();
    runPresentation(this.p);
    // the game's own rule ($EA7C, core's ScorePanel; port_v2 phase 7)
    this.host.screen.hudHidden = hudHidden(world);
    this.aimUi.update(pauseState(world), lookArrowsState(world));
    this.card.update(cardState(world));
  }

  private handOff(world: World): void {
    const jump = world.get(AimUi)!.jump;
    if (jump !== 0) {
      // the pause menu's COURSE SELECT SCREEN / QUIT ($80:843E to $16E3 / $16D9):
      // until the shell's map and title (port_v2 phase 7, pieces 4 and 5), the menu
      world.set(AimUi, { ...world.get(AimUi)!, jump: 0, pause: 0 });
      this.leaving = true;
      endGame(world);
      this.scene.start(SceneKeys.Menu, { host: this.host });
      return;
    }
    const phase = world.get(HoleFlow)!.phase;
    if (phase === 'HoleOver') {
      this.leaving = true;
      this.scene.restart({ host: this.host, advance: true });
    } else if (phase === 'GameOver') {
      this.leaving = true;
      this.scene.start(SceneKeys.Result, { host: this.host, mode: 'over' });
    } else if (phase === 'CourseDone') {
      this.leaving = true;
      this.scene.start(SceneKeys.Result, { host: this.host, mode: 'course' });
    } else if (phase === 'Idle') {
      // no hole running (endGame): nothing to host
      this.leaving = true;
      this.scene.start(SceneKeys.Menu, { host: this.host });
    }
  }

  /**
   * `?debug`: window.__engine, for the e2e scripts and the console. `step`
   * runs core frames with a pad (frozen hosts only advance through it);
   * `isolatePanel` hides everything but the shot panel for the pixel check.
   */
  private exposeDebug(world: World): void {
    const kirby = (): KirbyView | null => {
      for (const [, v] of this.views.entries()) if (v instanceof KirbyView) return v;
      return null;
    };
    const api = {
      host: this.host,
      world,
      scene: this,
      views: this.views,
      panel: this.p.panel,
      director: this.director,
      phase: (): string => world.get(HoleFlow)!.phase,
      hole: (): { set: string | null; holeIndex: number; rom: number | null; name: string; song: number } => {
        const h = this.holeAssets(world);
        return {
          set: this.host.set?.id ?? null,
          holeIndex: world.get(Session)!.holeIndex,
          rom: h?.layersOf ?? null,
          name: h?.data.name ?? '',
          song: h?.data.song ?? 0,
        };
      },
      frame: (): number => world.get(Time)!.frame,
      flow: () => ({ ...world.get(HoleFlow)!, camera: { ...world.get(Camera)! } }),
      /** The RESULT card up now with these strokes (a look at the view; core's flow resumes from the wait). */
      showCard: (strokes: number[] = [2]): void => {
        const c = world.get(Career)!;
        strokes.forEach((n, k) => { c.card[k] = n; });
        world.get(Session)!.holeIndex = Math.max(0, strokes.length - 1);
        world.set(HoleFlow, { ...world.get(HoleFlow)!, phase: 'Card', since: world.get(Time)!.frame - 40, length: 0 });
        world.set(Screen, { bright: 15, blank: 0 });
        this.present(world);
      },
      scroll: (): { x: number; y: number } => ({ x: this.cameras.main.scrollX, y: this.cameras.main.scrollY }),
      kirby: () => {
        const k = kirby();
        return k ? { ...k.position, clip: k.current } : null;
      },
      depths: (): Record<string, number[]> => {
        const out: Record<string, number[]> = {};
        for (const [e, v] of this.views.entries()) {
          const d = this.views.sortY.get(e);
          if (d === null || d === undefined) continue;
          // Kirby's own: behind the course his priority, not the sort, decides
          (out[v.kind] ??= []).push(v instanceof KirbyView ? v.depth : (v.band === 'decal' ? DEPTH.decal : DEPTH.actor) + d * 1e-5);
        }
        return out;
      },
      freeEnemies: () => freeEnemies(world),
      hitNextEnemy: (): boolean => hitNextEnemy(world),
      putOnCup: (lift = 0): boolean => putOnCup(world, lift),
      placeBall: (p: BallPlacement): void => placeBall(world, p),
      warp: () => ({ ...world.get(Warp)! }),
      switches: () => {
        const s = world.get(Switches)!;
        const w = findActivePlayer(world)?.get(BallWork);
        return {
          toggleOn: w?.toggleOn ?? 0, waterOff: w?.waterOff ?? 0,
          dissolve: { ...s.dissolve }, toggle: s.toggle && { ...s.toggle }, water: s.water && { ...s.water },
          anims: s.anims.map((a) => ({ ...a })), rippleTicks: s.rippleTicks,
        };
      },
      aimUi: () => ({ ...world.get(AimUi)!, panel: world.get(ScorePanel)!.shown, hudOn: world.get(ScorePanel)!.hudOn, aim: world.get(Shot)!.aim }),
      freeze: (on = true): void => {
        this.frozen = on;
      },
      step: (pad = 0, frames = 1): void => {
        for (let i = 0; i < frames; i++) {
          world.set(Pad, { ...world.get(Pad)!, raw: pad });
          runCoreFrame(world);
          this.history.sample(world, true);
        }
        this.p.events = drainEvents(world);
        this.present(world);
      },
      isolatePanel: (): void => {
        this.frozen = true;
        const keep = new Set<Phaser.GameObjects.GameObject>(this.p.panel.objects);
        for (const o of this.children.list) if (!keep.has(o)) (o as unknown as Phaser.GameObjects.Components.Visible).setVisible?.(false);
        this.cameras.main.setBackgroundColor(0x000000);
        this.host.screen.hudHidden = true;
        this.scene.get(SceneKeys.Hud)?.scene.setVisible(false);
      },
    };
    (window as unknown as { __engine: typeof api }).__engine = api;
  }
}
