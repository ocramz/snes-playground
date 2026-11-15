/**
 * Tomatoes and lives (plans phase 6 §4; read 2026-11-14 and pinned by the
 * flow traces' `tom`/`tqr`/`tqw`/`lives` and the stepper's sound log):
 *
 * - `$83:ABC5` / `$83:ABAD` push a -1 / +1 into the ring `$68FA`; the HUD
 *   thread ($84:98EC -> $83:ABDD) takes one entry when idle, counts 20
 *   frames and applies it. A push from the launch (before the thread runs
 *   in its frame) shows 20 frames later (web_flow 2983 -> 3003), one from the
 *   ball step (after it) 21 (3067 -> 3088): `apply-tomato-queue` sits
 *   between the flow systems and the ball step.
 * - `$83:ABEC`: +1 only while the result stays under 5 (sfx $52); -1 only
 *   while it stays at 0 or more (sfx $10). The refill and the hole-out bonus
 *   call it directly, unqueued.
 * - Lives: -1 with sfx $0B (`$80:F876`, `$80:F8D0`); +1 below 100 (`$80:F62D`).
 */
import type { World } from 'koota';
import {
  Tomatoes, TomatoQueue, Career, type TomatoQueueState, TOMATO_MAX, TOMATO_QUEUE_FRAMES, TOMATO_HUD_HIDE, LIVES_MAX,
} from '../traits/counters';
import { BallWork } from '../traits/ball';
import { emitEvent } from './flow-util';
import { tickHazards } from './actors';

function player(world: World): import('koota').Entity | undefined {
  return world.queryFirst(BallWork);
}

/** `$83:ABC5` (delta -1) / `$83:ABAD` (+1): queue a tomato change. */
export function pushTomato(world: World, delta: 1 | -1): void {
  const q = world.get(TomatoQueue)!;
  q.entries.push(delta);
  q.pushed += 1;
}

/** `$83:ABDD`'s two halves: apply a change now (sfx only when it lands). */
export function changeTomatoes(world: World, delta: 1 | -1): void {
  const e = player(world);
  if (e === undefined) return;
  const n = e.get(Tomatoes)!.n;
  if (delta > 0) {
    if (n + 1 > TOMATO_MAX) return; // $83:ABFD CMP / BCS: not stored, no sound
    e.set(Tomatoes, { n: n + 1 });
    emitEvent(world, 'tomato-gain', 0x52);
  } else {
    if (n - 1 < 0) return; // $83:AC10 BMI
    e.set(Tomatoes, { n: n - 1 });
    emitEvent(world, 'tomato-loss', 0x10);
  }
}

/**
 * The thread scheduler's tick at the frame's end: the HUD thread (the
 * tomato queue) and the hazard actors. Not in a frame the cup reveal's
 * decompression wait holds it.
 */
export function threadTick(world: World, ctx: import('../sim/context').Ctx): void {
  const q = world.get(TomatoQueue)!;
  if (q.hold > 0) {
    q.hold -= 1;
    return;
  }
  applyTomatoQueue(world);
  tickHazards(world, ctx);
}

/** The HUD thread takes the next entry: 20 ticks to its change. */
function takeEntry(q: TomatoQueueState): void {
  q.pending = q.entries.shift()!;
  q.timer = TOMATO_QUEUE_FRAMES;
  q.visible = true; // $84:9925
  q.hideTimer = -1;
}

/**
 * `apply-tomato-queue`: the HUD thread's tick ($84:98F8, state $541C:
 * 0 take, 1 count, 2 apply, 3 the hide countdown). The tick that applies an
 * entry takes the next queued one too ($84:9955: timer 20, back to 1), so
 * queued changes land 20 ticks apart (web_haz98: 2474, 2494).
 */
export function applyTomatoQueue(world: World): void {
  const q = world.get(TomatoQueue)!;
  if (q.pending === null) {
    if (q.entries.length > 0) {
      takeEntry(q);
      return;
    }
    if (q.hideTimer > 0) {
      q.hideTimer -= 1;
      if (q.hideTimer === 0) {
        q.visible = false; // $84:9990
        q.hideTimer = -1;
      }
    }
    return;
  }
  q.timer -= 1;
  if (q.timer > 0) return;
  const d = q.pending;
  q.pending = null;
  q.applied += 1;
  q.hideTimer = TOMATO_HUD_HIDE;
  changeTomatoes(world, d > 0 ? 1 : -1);
  if (q.entries.length > 0) takeEntry(q);
}

export function setTomatoes(world: World, n: number): void {
  const e = player(world);
  if (e !== undefined) e.set(Tomatoes, { n });
}

export function tomatoes(world: World): number {
  const e = player(world);
  return e === undefined ? 0 : e.get(Tomatoes)!.n;
}

/** -1 life with sfx $0B (`$80:F876` / `$80:F8D0`). */
export function loseLife(world: World): void {
  const c = world.get(Career)!;
  c.lives = Math.max(0, c.lives - 1);
  emitEvent(world, 'life-lost', 0x0b);
}

/** +1 life, stored only below 100 (`$80:F610-$80:F62D`). */
export function gainLife(world: World): void {
  const c = world.get(Career)!;
  if (c.lives + 1 <= LIVES_MAX) c.lives += 1;
}
