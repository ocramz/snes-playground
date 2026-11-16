/**
 * Which cutscene runs, and its frame (replay.ts has the timing against
 * core). It plugs into the host frame (bridge/frame-loop.ts):
 * - `beforeTick` holds the core during the intro's first INTRO_CORE_AT
 *   ticks (the hole is spawned, the set-up has not begun);
 * - `afterTick` starts a hole-out on the frame the ball has sunk (BallHoled
 *   2: core's holed effect $21 and Kirby's state 1 come on that frame,
 *   web_hole 3908) as the recording's index 2 (c1n's $21 at 3123: its ball
 *   was put on the cup's centre and sank 2 frames after $DA4A was set; a
 *   rolled-in ball takes longer, web_hole 3894 -> 3908), and follows core's
 *   HoleOut: the index is f - H until the camera reaches the cup (on C,
 *   HoleFlow.since + HoleFlow.length), then 29 + f - C;
 * - `takeCues` hands play-feedback the window's own sounds.
 * While a window runs it says what the ordinary views hide (Kirby, the tee
 * pad, the cup's ring: the replay draws its own), whether its camera
 * replaces core's, the brightness, and the night swap.
 */
import type { World } from 'koota';
import type { GameEvent } from '../../../core/events';
import { BallHoled } from '../../../core/traits/ball';
import { findActivePlayer } from '../../../core/traits/player';
import { Strokes } from '../../../core/traits/counters';
import { HoleFlow } from '../../../core/traits/flow';
import { Time } from '../../../core/traits/time';
import type { CutsceneWindow, CutscenesJson } from '../../assets/schema';
import {
  cueEvents, outroIndex, replayFrame, windowOf, INTRO_CORE_AT, OUTRO_ARRIVAL, OUTRO_HOLED_SFX_AT,
  type Anchors, type ReplayFrame, type WindowName,
} from './replay';

/** What a cutscene hides of the ordinary views this frame. */
export type Hideable = 'ball' | 'tee' | 'ring';

export class CutsceneDirector {
  private name: WindowName | null = null;
  private w: CutsceneWindow | null = null;
  private index = 0;
  private next = 0;
  private cued = -1;
  private holedAt = -1;
  private arrivedAt = 0;
  private anchors: Anchors | null = null;
  private cues: GameEvent[] = [];
  /** The hole's song, played at the intro's song cues (undefined: the recorded one). */
  private song: number | undefined = undefined;

  constructor(
    private readonly cutscenes: CutscenesJson | null,
    private readonly anchorsOf: () => Anchors | null,
  ) {}

  /**
   * The hole's intro: the star brings Kirby to the tee, and the hole's `song`
   * starts where the recording's did. False when there is no recording.
   */
  startIntro(song?: number): boolean {
    const w = windowOf(this.cutscenes, 'intro');
    const anchors = this.anchorsOf();
    if (!w || !anchors) return false;
    this.song = song;
    this.begin('intro', w, anchors);
    return true;
  }

  private begin(name: WindowName, w: CutsceneWindow, anchors: Anchors): void {
    this.name = name;
    this.w = w;
    this.anchors = anchors;
    this.index = 0;
    this.next = 0;
    this.cued = -1;
  }

  private cue(to: number, frame: number): void {
    if (!this.w || !this.name || to <= this.cued) return;
    this.cues.push(...cueEvents(this.name, this.w, this.cued + 1, to + 1, frame, this.song));
    this.cued = to;
  }

  beforeTick(world: World): boolean {
    if (this.name !== 'intro' || !this.w) return true;
    if (this.next >= this.w.length) {
      this.end();
      return true;
    }
    this.index = this.next++;
    this.cue(this.index, world.get(Time)!.frame);
    return this.index >= INTRO_CORE_AT;
  }

  afterTick(world: World, ran: boolean): void {
    if (!ran) return;
    const f = world.get(Time)!.frame;
    if (this.name === null && this.holedAt < 0) {
      const ball = findActivePlayer(world);
      if (ball && ball.get(BallHoled)!.holed === 2) {
        this.holedAt = f - OUTRO_HOLED_SFX_AT;
        const hio = ball.get(Strokes)!.n === 2;
        const w = windowOf(this.cutscenes, hio ? 'outroHio' : 'outro');
        const anchors = this.anchorsOf();
        if (w && anchors) this.begin(hio ? 'outroHio' : 'outro', w, anchors);
      }
    }
    if (this.name === 'outro' || this.name === 'outroHio') {
      const flow = world.get(HoleFlow)!;
      // HoleFlow.length is C's t in the phase (systems/hole-flow.ts holeOut)
      if (flow.phase === 'HoleOut' && flow.length > 0) this.arrivedAt = flow.since + flow.length;
      this.index = Math.min(this.w!.length - 1, outroIndex(f, this.holedAt, this.arrivedAt));
      this.cue(this.index, f);
    }
  }

  takeCues(): GameEvent[] {
    return this.cues.splice(0);
  }

  private end(): void {
    this.name = null;
    this.w = null;
  }

  get active(): WindowName | null {
    return this.name;
  }

  /** The window's frame now, or null. */
  frame(): ReplayFrame | null {
    if (!this.w || !this.anchors) return null;
    return replayFrame(this.w, this.index, this.anchors);
  }

  /** The replay's camera replaces core's: through the intro, and in a hole-out once the camera has reached the cup. */
  ownsCamera(): boolean {
    if (this.name === 'intro') return true;
    return this.name !== null && this.index >= OUTRO_ARRIVAL;
  }

  hidden(): ReadonlySet<Hideable> {
    const out = new Set<Hideable>();
    if (!this.w) return out;
    out.add('tee');
    if (this.name === 'intro') out.add('ball');
    else {
      out.add('ring');
      if (this.w.hideKirby !== null && this.index >= this.w.hideKirby) out.add('ball');
    }
    return out;
  }

  /** HOLE IN ONE's night palette is on. */
  night(): boolean {
    return this.name === 'outroHio' && this.w!.night !== null && this.index >= this.w!.night;
  }

  get position(): { window: WindowName | null; index: number } {
    return { window: this.name, index: this.index };
  }
}
