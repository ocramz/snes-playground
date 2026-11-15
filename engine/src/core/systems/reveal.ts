/**
 * The cup reveal, `$82:8B5C` (read 2026-11-14; plans phase 6 §3): when the
 * take leaves one enemy free, that enemy becomes the cup, inside the ball
 * step that took the other — the step blocks until the reveal is over and
 * then finishes (the block is not written meanwhile: web_flow's ball records
 * 3245 -> 3345). The reveal's own frames, in the ROM's order, measured on
 * web_flow/web_curve and on course 1's four first holes (the autoplay
 * replay, `--log-pc` on $82:8B5C, $82:8D5A, $82:8C4F, $82:8C27, $82:8C45):
 *
 *   lead     the cup graphics' decompression wait (`$82:8BDD`, a frame at a
 *            time while $AB is set): 8 frames to the pan stage `$82:8D5A`
 *            (holes 1-4: 3003/3011, 4344/4352, 5684/5692, 7123/7131). The HUD
 *            thread does not run in 5 of them (the tomato queue's +1 lands at
 *            take + 25 instead of + 20: web_flow 3245 -> 3271 line 21).
 *   panTo    `$82:8D5A`: the enemy on screen (its draw position, the cell
 *            corner's projection, minus the scroll, inside $10-$C7 x $10-$D3)
 *            -> nothing; else a frame, then the pan toward the cup's
 *            projection ($ECBB/$ECBD, `$81:BA8A`), until a pan finds the
 *            camera there (hole 3: 30 frames, 5692 -> 5722; hole 4: 35).
 *   hover    `$82:8C4F`: a hovering enemy on screen drops ($82:8CE8[h] + 8
 *            frames; unmeasured).
 *   ring     objects 74 (the ring), 78, 97, 79 spawn; sfx $1C 31 frames on
 *            (`$82:8D49`; 3011/3042, 4352/4383); object 97 raises `$6B88`,
 *            which `$82:8C1C` waits for: 92 frames on (3011/3103, 4352/4444).
 *            After a pan both come a frame earlier (5722: $1C 5752, the end
 *            5813; 7166: 7196, 7257).
 *   panBack  `$82:8C27`: a pan toward the camera saved at the take, then a
 *            frame, until a pan finds it there (none when it never moved;
 *            hole 3: 5813 -> 5842).
 *
 * On entry ($82:8B5C-$82:8BBB): the enemy latch `$6A68` is cleared, the
 * camera saved, the enemy's kind set to 8, the aim target `$6B6C-$6B72`
 * set to the cup (6:$8C00 / 5:$7800 on hole 1: x + $8C00, y + $7800), and
 * tile $08 written into layer 2 at its cell.
 */
import type { World } from 'koota';
import { Camera } from '../traits/camera';
import { Shot } from '../traits/shot';
import { Course, courseEntity } from '../traits/course';
import { Cell, EnemyKind, Hover, IsCup, IsEnemy, TakenBy } from '../traits/hole';
import { Visual } from '../traits/visual';
import { TomatoQueue } from '../traits/counters';
import { BallWork } from '../traits/ball';
import { panStep } from '../sim/camera';
import { project } from '../projection';
import { actorGround } from '../sweep';
import type { Ctx } from '../sim/context';
import { emitEvent } from './flow-util';
import { HOVER_DROP, HOVER_DROP_EXTRA, Reveal, type RevealStage } from '../traits/reveal';

/** Frames from the take to the pan stage $82:8D5A (measured, see the header). */
export const REVEAL_LEAD = 8;
/** Of those, the frames in which the HUD thread does not run (measured). */
export const REVEAL_HUD_HOLD = 5;
/** From the ring stage's start to sfx $1C (`$82:8D49`). */
export const RING_SFX_AT = 31;
/** From the ring stage's start to object 97's `$6B88` (`$82:8C1C`). */
export const RING_FRAMES = 92;

/**
 * Begin the reveal for `cup` (the last free enemy). Called from the take,
 * mid-step; the caller then suspends the step with a `cupReveal` stall.
 */
export function startReveal(world: World, ctx: Ctx, cup: import('koota').Entity, extraLead = 0): void {
  const { x, y } = cup.get(Cell)!;
  const ball = world.queryFirst(BallWork)!;
  ball.get(BallWork)!.enemyLatch = 0; // $82:8B65: STZ $6A68,X
  const cam = world.get(Camera)!;
  // $82:8B77: kind 8; the cup is the enemy itself from now on
  cup.add(IsCup);
  cup.set(Visual, { kind: 'cup' });
  // $82:8B7D-$82:8BB8: the aim target, the cup's ring centre
  world.set(Shot, {
    ...world.get(Shot)!,
    targetXc: x, targetXf: 0x8c00,
    targetYc: y, targetYf: 0x7800,
  });
  // $82:8BBB: tile $08 into layer 2 (the kernels share this array)
  const course = courseEntity(world);
  const c = course.get(Course)!;
  c.layer2[y * c.w + x] = 0x08;
  course.changed(Course);
  // $82:8D5A: the cup's projection, and whether the enemy is on screen
  const ground = actorGround(ctx.rules, ctx.course, x, y);
  const p = project(ctx.course, x, 0x8c00, y, 0x7800, ground);
  const corner = project(ctx.course, x, 0, y, 0, ground);
  const ex = corner.x;
  const ey = ctx.course.screenBase - corner.y; // the bitmap's y ($5F9C)
  const scrollX = cam.x;
  const scrollY = (ctx.course.screenBase - cam.y) & 0xffff;
  const sx = (ex + 0x20 - scrollX) | 0;
  const sy = (ey - 4 - scrollY) | 0;
  const onScreen = sx >= 0x10 && sx < 0xc8 && sy >= 0x10 && sy < 0xd4 ? 1 : 0;
  const hover = cup.has(Hover) ? cup.get(Hover)!.steps : 0;
  world.set(Reveal, {
    stage: 'lead', t: -extraLead, total: 0,
    cupX: x, cupY: y,
    savedX: cam.x, savedY: cam.y,
    panX: p.x, panY: p.y,
    onScreen,
    hoverFrames: hover !== 0 && onScreen ? HOVER_DROP[hover & 7] + HOVER_DROP_EXTRA : 0,
    panned: 0,
  });
  const q = world.get(TomatoQueue)!;
  q.hold = REVEAL_HUD_HOLD;
}

/**
 * One frame of the reveal's own list. Returns true on the frame the step
 * resumes (the stall runner then finishes the step and runs the post-step
 * systems, as after a hit-stop).
 */
export function tickReveal(world: World): boolean {
  const r = { ...world.get(Reveal)! };
  r.total += 1;
  r.t += 1;
  const advance = (stage: RevealStage): void => {
    r.stage = stage;
    r.t = 0;
  };
  for (;;) {
    switch (r.stage) {
      case 'lead':
        if (r.t < REVEAL_LEAD) {
          world.set(Reveal, r);
          return false;
        }
        advance('panTo');
        continue;
      case 'panTo': {
        if (r.onScreen) {
          advance('hover');
          continue;
        }
        // $82:8D8F: a frame first, then the pan
        if (r.t === 0) {
          world.set(Reveal, r);
          return false;
        }
        const cam = { ...world.get(Camera)! };
        panStep(cam, r.panX, r.panY);
        world.set(Camera, cam);
        if (cam.arrived) {
          r.panned = 1;
          advance('hover');
          continue;
        }
        world.set(Reveal, r);
        return false;
      }
      case 'hover':
        if (r.hoverFrames > 0 && r.t < r.hoverFrames) {
          world.set(Reveal, r);
          return false;
        }
        advance('ring');
        r.t = r.panned ? 1 : 0; // after a pan the ring's frames come one sooner (measured)
        continue;
      case 'ring':
        if (r.t === RING_SFX_AT) emitEvent(world, 'cup-reveal', 0x1c);
        if (r.t < RING_FRAMES) {
          world.set(Reveal, r);
          return false;
        }
        advance('panBack');
        continue;
      case 'panBack': {
        // $82:8C27: the pan aims at (px - 128, py + 112): hand it the saved
        // camera + (128, -112); it ends on the pan that finds it there
        const cam = { ...world.get(Camera)! };
        panStep(cam, (r.savedX + 0x80) & 0xffff, (r.savedY - 0x70) & 0xffff);
        world.set(Camera, cam);
        if (cam.arrived) {
          world.set(Reveal, { ...r, stage: 'none', t: 0 });
          return true;
        }
        world.set(Reveal, r);
        return false;
      }
      default:
        return true;
    }
  }
}

/** The free enemies in list order ($82:8ACE counts them, $82:8AEE takes the first). */
export function freeEnemies(world: World): import('koota').Entity[] {
  const out: import('koota').Entity[] = [];
  for (const e of world.query(IsEnemy, EnemyKind)) {
    if (e.has(IsCup)) continue;
    if (e.targetFor(TakenBy) !== undefined) continue;
    out.push(e);
  }
  return out.sort((a, b) => a.get(EnemyKind)!.listIndex - b.get(EnemyKind)!.listIndex);
}
