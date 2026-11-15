/**
 * The hole and course loop on the test courses (plans phase 6 §5 and §8):
 * the paths the recorded runs cover only in part — a hole in one, a lost
 * ball on another hole, the tomatoes running out with no life left, GAME
 * OVER and CONTINUE, the whole course to its end. Driven like autoplay
 * (test/course-driver.ts). The frame offsets inside each phase are the
 * recorded game's (web_hole, web_tomatoes, web_fly; hole-flow.ts); what
 * this file pins is that the phases chain into one another.
 */
import { describe, expect, it } from 'vitest';
import { CourseDriver } from './course-driver';
import { haveRules } from './fixtures';
import { nextHole, continueGame, pause, resume } from '../src/core/actions';
import { HoleFlow } from '../src/core/traits/flow';
import { Session } from '../src/core/traits/session';
import { Tomatoes, Stars, Strokes, Career } from '../src/core/traits/counters';
import { BallPos, BallVel, BallWork } from '../src/core/traits/ball';
import { Warp } from '../src/core/traits/warp';
import { WARP_HOLD, WARP_IN, WARP_LEAD, WARP_OUT } from '../src/core/systems/warp';
import { Pose } from '../src/core/traits/pose';
import { Time } from '../src/core/traits/time';
import { Shot } from '../src/core/traits/shot';
import { IsCup, IsEnemy, IsHole, InHole } from '../src/core/traits/hole';
import { placeBall } from '../src/core/actions';
import {
  HOLEOUT_FRAMES, HOLEOUT_HIO_FRAMES, OOT_LIFE_AT, OOT_SETUP_AT, LOST_RESET_AT, RESPAWN_FRAMES,
} from '../src/core/systems/hole-flow';

const kinds = (d: CourseDriver, from = 0): string[] =>
  d.events.filter((e) => e.t >= from && e.kind !== 'aim-tick').map((e) => `${e.kind}${e.romSfx >= 0 ? ':' + e.romSfx.toString(16) : ''}`);

describe.skipIf(!haveRules)('the hole and course loop on the test courses', () => {
  it('t1 in one shot: the takes, the cup, the sink, the hole in one, the next hole', () => {
    const d = new CourseDriver();
    d.playHole();
    const ball = d.world.queryFirst(BallWork)!;
    expect(ball.get(Stars)!.n).toBe(2);
    expect(d.world.get(Career)!.card[0]).toBe(1);
    expect(d.world.get(Career)!.lives).toBe(3); // 2 + the 1UP
    expect(ball.get(Pose)!.state).toBe(1); // holed out
    // the event timeline's order (frames: hole-flow.ts' measured offsets)
    const k = kinds(d);
    const order = [
      'aim-confirm:34', 'power-start:57', 'silence:0', 'silence:0', 'launch:18',
      'enemy-taken:4f', 'enemy-taken:4f', 'tomato-loss:10', 'tomato-gain:52', 'cup-reveal:1c',
      'holed-in', 'music-mute', 'holed:21', 'song:0', 'song:1a', 'song:18',
    ];
    expect(k).toEqual(order);
    // the hole-in-one hole-out lasts 760 frames from the card ($83:D2BF's path)
    const holed = d.events.find((e) => e.kind === 'holed')!;
    expect(d.frame - holed.frame).toBeGreaterThan(HOLEOUT_HIO_FRAMES);
    expect(d.world.queryFirst(IsCup)).toBeDefined();
    // the RESULT card's button: hole 2, its own entities, the counters reset
    const holes = d.world.query(IsHole);
    nextHole(d.world);
    expect(holes[0].isAlive()).toBe(false);
    expect(d.phase).toBe('ShotSetup');
    expect(d.world.get(Session)!.holeIndex).toBe(1);
    expect(ball.get(Strokes)!.n).toBe(1);
    expect(ball.get(Stars)!.n).toBe(0);
    expect(ball.get(Tomatoes)!.n).toBe(4); // carried over (capped)
    expect(d.world.query(IsCup)).toHaveLength(0);
    expect(d.world.query(IsEnemy).every((e) => e.has(InHole('*')))).toBe(true);
  });

  it('t2 in two shots: the ordinary hole-out (song 25, the bonus tomato, the card 2)', () => {
    const d = new CourseDriver();
    nextHole(d.world); // t2
    d.shoot(); // a weak shot that takes nothing
    d.untilPhase('ShotSetup');
    const from = d.frame;
    d.playHole();
    expect(d.world.get(Career)!.card[1]).toBe(2);
    expect(d.world.get(Career)!.lives).toBe(2);
    const k = kinds(d, from);
    // 4 - 2 shots + 2 takes = 4: the bonus tomato is capped, so it is silent
    expect(k.slice(-3)).toEqual(['holed:21', 'song:19', 'song:18']);
    expect(d.world.queryFirst(BallWork)!.get(Tomatoes)!.n).toBe(4);
    const holed = d.events.find((e) => e.kind === 'holed')!;
    const done = d.frame;
    expect(done - holed.frame).toBeGreaterThan(HOLEOUT_FRAMES);
    expect(done - holed.frame).toBeLessThan(HOLEOUT_FRAMES + 60);
  });

  it('t5: a ball off the island is lost: tomatoes 0, a life, the refill, the ball back at the origin', () => {
    const d = new CourseDriver();
    for (let i = 0; i < 4; i++) nextHole(d.world); // t5
    d.shoot();
    const shot = d.world.get(Shot)!;
    const origin = { xc: shot.originXc, xf: shot.originXf, yc: shot.originYc, yf: shot.originYf, z: shot.originZ };
    // over the gap (columns 5-6) and moving on into it
    placeBall(d.world, { xc: 5, xf: 0x4000, yc: 4, yf: 0x8000, z: 0x5a82, vx: 0x0800, vy: 0, vz: 0, air: 1 });
    d.untilPhase('BallLost', 600);
    const lost = d.frame;
    d.untilPhase('Respawn', 200);
    expect(d.frame - lost).toBe(LOST_RESET_AT);
    const e = d.world.queryFirst(BallWork)!;
    expect(e.get(Tomatoes)!.n).toBe(0);
    expect({ ...e.get(BallPos)! }).toEqual(origin);
    d.untilPhase('ShotSetup', RESPAWN_FRAMES + 5);
    expect(e.get(Tomatoes)!.n).toBe(4);
    expect(d.world.get(Career)!.lives).toBe(1);
    expect(kinds(d, lost)).toEqual(['song:0', 'ball-lost:54', 'song:b', 'life-lost:b', ...Array(4).fill('tomato-gain:52')]);
  });

  it('t6: rolled onto the warp $B3 at (9,5), the ball comes out of $B1 at (1,5) heading east', () => {
    const d = new CourseDriver();
    for (let i = 0; i < 5; i++) nextHole(d.world); // t6
    d.shoot();
    // rolling west into (9,5)'s centre window
    placeBall(d.world, { xc: 10, xf: 0x2000, yc: 5, yf: 0x8000, z: 0x5a82, vx: 0xf800, vy: 0, vz: 0, air: 0 });
    const from = d.frame;
    d.until(() => d.world.get(Warp)!.stage !== 'none', 60, 'the warp');
    const start = d.frame;
    d.until(() => d.world.get(Warp)!.stage === 'none', 400, 'the warp\'s end');
    const pos = d.world.queryFirst(BallWork)!.get(BallPos)!;
    expect([pos.xc, pos.yc]).toEqual([1, 5]);
    const vel = d.world.queryFirst(BallWork)!.get(BallVel)!;
    expect(vel.vy).toBe(0);
    expect(vel.vx).toBeGreaterThan(0);
    expect(vel.vx).toBeLessThan(0x0800);
    expect(kinds(d, from).filter((k) => k.startsWith('warp'))).toEqual(['warp:76', 'warp:77']);
    // the stall: 10 + 38 + the pan + 26 + 20 frames
    expect(d.frame - start).toBeGreaterThanOrEqual(WARP_LEAD + WARP_OUT + 1 + WARP_IN + WARP_HOLD);
    // the latch: the ball rolls off (1,5) without warping back
    d.step(60);
    expect(kinds(d, from).filter((k) => k.startsWith('warp'))).toHaveLength(2);
  });

  it('t1: four shots spend the tomatoes; tired twice, asleep, a life for the refill, the same hole', () => {
    const d = new CourseDriver();
    const seen: string[] = [];
    for (let shot = 0; shot < 4; shot++) {
      d.shoot();
      d.until(() => d.phase === 'Aim' || d.phase === 'Tired' || d.phase === 'OutOfTomatoes', 1500);
      seen.push(d.phase);
    }
    // 4 -> 3 (no pose) -> 2 (tired) -> 1 (tired) -> 0 (asleep)
    expect(seen).toEqual(['Aim', 'Tired', 'Tired', 'OutOfTomatoes']);
    const oot = d.frame;
    const ball = d.world.queryFirst(BallWork)!;
    const where = { ...ball.get(BallPos)! };
    d.untilPhase('ShotSetup', OOT_SETUP_AT + 5);
    expect(d.frame - oot).toBe(OOT_SETUP_AT);
    expect(ball.get(Tomatoes)!.n).toBe(4);
    expect(d.world.get(Career)!.lives).toBe(1);
    expect(d.world.get(Session)!.holeIndex).toBe(0);
    expect({ ...ball.get(BallPos)! }).toEqual(where); // where it lies
    expect(ball.get(Strokes)!.n).toBe(5); // the set-up of the fifth shot (t1 of it next frame)
    void OOT_LIFE_AT;
  });

  it('no life left: GAME OVER, then CONTINUE starts the course again with 2 lives and 4 tomatoes', () => {
    const d = new CourseDriver();
    d.world.get(Career)!.lives = 0;
    for (let shot = 0; shot < 4; shot++) {
      d.shoot();
      d.until(() => d.phase === 'Aim' || d.phase === 'Tired' || d.phase === 'OutOfTomatoes', 1500);
    }
    d.untilPhase('GameOver', 400);
    expect(kinds(d).at(-1)).toBe('game-over');
    d.step(30);
    expect(d.phase).toBe('GameOver'); // it waits for an answer
    continueGame(d.world);
    expect(d.phase).toBe('ShotSetup');
    expect(d.world.get(Career)!.lives).toBe(2);
    expect(d.world.queryFirst(BallWork)!.get(Tomatoes)!.n).toBe(4);
    expect(d.world.get(Career)!.card.every((c) => c === -1)).toBe(true);
    expect(d.world.get(Session)!.holeIndex).toBe(0);
  });

  it('the whole course: eight holes, then CourseDone with the card', () => {
    const d = new CourseDriver();
    for (let i = 0; i < 8; i++) {
      d.playHole();
      expect(d.world.get(HoleFlow)!.phase, `hole ${i}`).toBe('HoleOver');
      nextHole(d.world);
    }
    expect(d.phase).toBe('CourseDone');
    expect(d.world.get(Career)!.card).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(d.world.query(IsHole)).toHaveLength(0);
    expect(d.world.get(Career)!.lives).toBe(2 + 8);
  });

  it('pause skips the frame; resume goes on', () => {
    const d = new CourseDriver();
    d.step(5);
    const f = d.world.get(Time)!.frame;
    pause(d.world);
    d.step(10);
    expect(d.world.get(Time)!.frame).toBe(f);
    resume(d.world);
    d.step(1);
    expect(d.world.get(Time)!.frame).toBe(f + 1);
  });
});
