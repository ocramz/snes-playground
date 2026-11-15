/**
 * random.html's menu (plans/random_holes.md): the seed and the difficulty,
 * and the course of 8 random holes generated from them (core/gen). The
 * generation runs here, a slice of about 10 ms a frame (the solver plays
 * every candidate hole with the engine's physics, so it takes a moment);
 * Enter plays the course once it is ready, N draws a new seed, Up/Down
 * change the difficulty. Registered as SceneKeys.Menu, so the Result
 * scene's END and the flow's Idle come back here, to replay the same seed.
 * The seed and the difficulty are kept in the page's URL.
 */
import Phaser from 'phaser';
import { SceneKeys } from '../scene-keys';
import { startCourse, startHole } from '../../core/actions';
import {
  DIFFICULTY_NAMES, generateCourse, type Difficulty, type GeneratedHole, type GenProgress,
} from '../../core/gen/generate';
import { randomCourseSet } from '../assets/course-sets';
import { addText, setGameText } from '../features/text/font';
import type { Host, SceneData } from '../host';

/** The holes of a random course. */
export const RANDOM_HOLES = 8;
/** Work per frame on the generator, in ms. */
const SLICE_MS = 10;

type Text = Phaser.GameObjects.BitmapText | Phaser.GameObjects.Text;

export class RandomMenuScene extends Phaser.Scene {
  private host!: Host;
  private gen: Generator<GenProgress, GeneratedHole[]> | null = null;
  private progress: GenProgress | null = null;
  private failed: string | null = null;
  private startWhenReady = false;
  private seedLine!: Text;
  private diffLine!: Text;
  private status!: Text;
  private pars!: Text;

  constructor() {
    super(SceneKeys.Menu);
  }

  init(data: SceneData): void {
    this.host = data.host;
    this.gen = null;
    this.progress = null;
    this.failed = null;
    this.startWhenReady = false;
  }

  create(): void {
    const host = this.host;
    host.screen.hudHidden = true;
    host.audio?.stopAll();
    this.cameras.main.setBackgroundColor(0x0b0b14);
    host.random ??= { seed: host.flags.seed ?? freshSeed(), difficulty: host.flags.difficulty ?? 1, holes: null };
    addText(this, 64, 24, 'RANDOM COURSE');
    this.seedLine = addText(this, 32, 56, '');
    this.diffLine = addText(this, 32, 72, '');
    this.status = addText(this, 32, 96, '');
    this.pars = addText(this, 32, 112, '');
    addText(this, 32, 152, 'ENTER PLAY   N NEW SEED');
    addText(this, 32, 168, 'UP/DOWN DIFFICULTY');
    addText(this, 32, 184, 'ARROWS AIM  Z SHOOT');
    addText(this, 32, 200, 'ESC PAUSE');
    if (!host.rules) {
      setGameText(this.status, 'NO RULES: SEE THE CONSOLE');
      return;
    }
    if (!host.random.holes) this.restart();
    this.draw();
    const kb = this.input.keyboard;
    if (!kb) return;
    const onKey = (ev: KeyboardEvent): void => {
      const r = host.random!;
      if (ev.code === 'Enter' || ev.code === 'KeyZ' || ev.code === 'Space') {
        this.startWhenReady = true;
      } else if (ev.code === 'KeyN') {
        r.seed = freshSeed();
        this.restart();
      } else if (ev.code === 'ArrowUp' || ev.code === 'ArrowDown') {
        r.difficulty = ((r.difficulty + (ev.code === 'ArrowUp' ? 2 : 1)) % 3) as Difficulty;
        this.restart();
      }
      this.draw();
    };
    kb.on(Phaser.Input.Keyboard.Events.ANY_KEY_DOWN, onKey);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => kb.off(Phaser.Input.Keyboard.Events.ANY_KEY_DOWN, onKey));
  }

  /** Throw the holes away and generate the course of the current seed and difficulty. */
  private restart(): void {
    const r = this.host.random!;
    r.holes = null;
    this.failed = null;
    this.progress = null;
    this.gen = generateCourse(this.host.rules!, r.seed, RANDOM_HOLES, { difficulty: r.difficulty });
    keepInUrl(r.seed, r.difficulty);
  }

  update(): void {
    const r = this.host.random;
    if (r && this.gen) {
      const until = performance.now() + SLICE_MS;
      try {
        while (performance.now() < until) {
          const step = this.gen.next();
          if (step.done) {
            r.holes = step.value;
            this.gen = null;
            this.expose();
            break;
          }
          this.progress = step.value;
        }
      } catch (e) {
        this.gen = null;
        this.failed = e instanceof Error ? e.message : String(e);
        console.error(e);
      }
      this.draw();
    }
    if (this.startWhenReady && r?.holes) this.play(r.holes);
  }

  private draw(): void {
    const r = this.host.random;
    if (!r) return;
    setGameText(this.seedLine, `SEED ${r.seed}`);
    setGameText(this.diffLine, `${DIFFICULTY_NAMES[r.difficulty]}`);
    if (this.failed) {
      setGameText(this.status, 'NO HOLE FOUND: N NEW SEED');
      setGameText(this.pars, '');
    } else if (r.holes) {
      setGameText(this.status, this.startWhenReady ? 'STARTING' : 'READY');
      const total = r.holes.reduce((s, h) => s + (h.solution?.par ?? 0), 0);
      setGameText(this.pars, `PAR ${r.holes.map((h) => h.solution?.par ?? '-').join(' ')}  ${total}`);
    } else {
      const p = this.progress;
      const hole = p ? p.hole + 1 : 1;
      setGameText(this.status, `GENERATING ${hole}/${RANDOM_HOLES}`);
      setGameText(this.pars, p ? `TRY ${p.attempt + 1}  SHOTS ${p.shots}` : '');
    }
  }

  private play(holes: GeneratedHole[]): void {
    const host = this.host;
    const r = host.random!;
    this.startWhenReady = false;
    host.set = randomCourseSet(holes, r.seed);
    startCourse(host.world, host.rules!, host.set.holes.map((h) => h.data));
    const first = host.flags.hole;
    if (first !== null && first > 1 && first <= holes.length) startHole(host.world, first - 1);
    if (!this.scene.isActive(SceneKeys.Hud)) this.scene.launch(SceneKeys.Hud, { host });
    this.scene.start(SceneKeys.Hole, { host });
  }

  /** ?debug: window.__random, the course as generated (the e2e test and the console read it). */
  private expose(): void {
    if (!this.host.flags.debug) return;
    const r = this.host.random!;
    (window as unknown as { __random?: unknown }).__random = {
      seed: r.seed,
      difficulty: r.difficulty,
      holes: r.holes?.map((h) => ({ name: h.json.name, json: h.json, seed: h.seed, attempt: h.attempt, par: h.solution?.par, plan: h.solution?.plan })),
    };
  }
}

/** A seed for the menu: 1-999999, so it is easy to type back into the URL. */
function freshSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return 1 + (a[0] % 999_999);
}

function keepInUrl(seed: number, difficulty: Difficulty): void {
  const url = new URL(window.location.href);
  url.searchParams.set('seed', String(seed));
  url.searchParams.set('difficulty', DIFFICULTY_NAMES[difficulty].toLowerCase());
  window.history.replaceState(null, '', url);
}
