/**
 * The aim stage's arithmetic (read 2026-11-14; build/engine/disasm/flow-*.txt):
 * the d-pad turn `$81:B555`, the shot-kind switch `$81:B5F9`/`$81:B661`, the
 * set-up's snap toward the target `$80:C902` with its direction
 * `$82:AFB0`, and the nearest free enemy `$82:8E41`. Pure functions over
 * plain numbers; the `update-aim` and `setup-shot` systems hold the state.
 */
import { atan2Deg, wrap16 } from '../fixed';
import type { RomRules } from '../rules';

/** The pad bits the aim stage tests ($0067 held, $006B pressed). */
export const PAD = {
  B: 0x8000, Y: 0x4000, SELECT: 0x2000, START: 0x1000,
  UP: 0x0800, DOWN: 0x0400, LEFT: 0x0200, RIGHT: 0x0100,
  A: 0x0080, L: 0x0020, R: 0x0010,
  DPAD: 0x0f00,
} as const;

/** What one call of $81:B555 changes. */
export interface AimInput {
  aim: number;
  hold: number; // $6ADE
  kind: number; // $6AD6
  grounder: number; // $6AD8
  elev: number; // $D9B6
  guideSide: number; // $D9B8
  guideTB: number; // $D9BA
  changed: number; // $6AE0
}

/**
 * $81:B555. No direction or shoulder held: the hold counter resets.
 * Right (held) turns the aim down, Left up: 1 degree on the first frame,
 * then nothing until the counter reaches 15, then 3 degrees a call. R / L
 * (pressed, with Right / Left not held) snap to the next octant down / up
 * through `snap`, the table at $81:B729 ($81:B6C3; port_v2 phase 7). Up
 * (held) chooses the fly shot, Down (pressed) the grounder, through the
 * kind state $6AD6.
 */
export function aimPad(s: AimInput, held: number, pressed: number, snap?: ArrayLike<number>): void {
  if ((held & 0x0f30) === 0) {
    s.hold = 0; // $81:B55D
    return;
  }
  if ((held & PAD.RIGHT) !== 0) {
    turn(s, -1);
  } else if ((pressed & PAD.R) !== 0) {
    s.hold = 0; // $81:B59D
    if (snap) {
      s.aim = snapOctant(s.aim, snap, -1); // $81:B5A0: A = $FFD3
      s.changed += 1;
    }
  }
  if ((held & PAD.LEFT) !== 0) {
    turn(s, +1);
  } else if ((pressed & PAD.L) !== 0) {
    s.hold = 0; // $81:B5EA
    if (snap) {
      s.aim = snapOctant(s.aim, snap, +1); // $81:B5ED: A = $002D
      s.changed += 1;
    }
  }
  if ((held & PAD.UP) !== 0) {
    // $81:B604: switch on $6AD6
    if (s.kind === 0) {
      // $81:B62E: wait while the counter is 1..29, else become a fly shot
      if (s.hold !== 0 && s.hold < 30) {
        s.hold += 1;
        return;
      }
      s.grounder = 0;
      s.kind = 2;
      s.guideSide = 6;
      s.guideTB = 6;
      s.elev = 60; // $81:B656
      s.changed += 1;
      return;
    }
    if (s.kind === 1) {
      // $81:B617: a fresh Up press returns to kind 0
      if ((pressed & PAD.UP) === 0) return;
      s.kind = 0;
      s.hold += 1;
      s.changed += 1;
      return;
    }
    return; // kind 2: already a fly shot ($81:B65C)
  }
  if ((held & PAD.DOWN) !== 0) {
    // $81:B661: switch on $6AD6
    if (s.kind === 0) {
      if ((pressed & PAD.DOWN) === 0) return; // $81:B67F
      s.hold = 0;
      s.kind = 1;
      s.changed += 1;
      return;
    }
    if (s.kind === 1) {
      if (s.changed === 0) s.hold = 0; // $81:B696
      return;
    }
    // kind 2 ($81:B6A4): back to a grounder
    s.grounder += 1;
    s.kind = 0;
    s.guideSide = 6;
    s.guideTB = 6;
    s.elev = 0; // $81:B6BC
    s.changed += 1;
  }
}

/**
 * $81:B6C3: the byte `snap[aim]`; its high nibble (dir -1, A negative) or
 * its low nibble (dir +1) times 45 is the new aim.
 */
export function snapOctant(aim: number, snap: ArrayLike<number>, dir: 1 | -1): number {
  const b = snap[aim] ?? 0;
  const n = dir < 0 ? (b >> 4) & 0x0f : b & 0x0f;
  return n * 45;
}

/** One direction's arm of $81:B555 ($81:B573 / $81:B5BE). */
function turn(s: AimInput, dir: 1 | -1): void {
  let step: number;
  if (s.hold === 0) {
    s.hold = 1;
    step = 1;
  } else if (s.hold < 15) {
    s.hold += 1;
    return; // no turn, no change
  } else {
    step = 3;
  }
  let a = s.aim + dir * step;
  if (a < 0) a += 0x168;
  if (a >= 0x168) a -= 0x168;
  s.aim = a;
  s.changed += 1;
}

/**
 * $80:A594: a cell + 16-bit fraction as one 8.8 word, rounded: the
 * fraction + $80 carries into the cell, then (cell low byte, fraction high
 * byte).
 */
export function to88(cell: number, frac: number): number {
  let c = cell;
  let f = frac + 0x80;
  if (f > 0xffff) {
    f &= 0xffff;
    c += 1;
  }
  return ((c & 0xff) << 8) | (f >> 8);
}

/** $82:AFB0: the heading from the ball to the target, degrees 0-359. */
export function aimToward(
  rules: RomRules,
  ballXc: number, ballXf: number, ballYc: number, ballYf: number,
  tXc: number, tXf: number, tYc: number, tYf: number,
): number {
  const dy = wrap16(to88(tYc, tYf) - to88(ballYc, ballYf));
  const dx = wrap16(to88(tXc, tXf) - to88(ballXc, ballXf));
  return atan2Deg(dx, dy, rules.table('atanDeg'));
}

/** $80:C902: the nearest multiple of 45 degrees (thresholds 23, 68, ... 338). */
export function snapAim(deg: number): number {
  const edges = [0x17, 0x44, 0x71, 0x9e, 0xcb, 0xf8, 0x125, 0x152];
  if (deg < edges[0]) return 0;
  for (let i = 1; i < edges.length; i++) if (deg < edges[i]) return 45 * i;
  return 0; // >= 338 ($80:C951)
}

/**
 * $82:8E41: the target is the free enemy (kind $40-$57, owner 2) nearest to
 * the ball, by the squared distance of the 8.8 positions ($80:A3F5); ties
 * keep the first in the list. The enemy cell's centre is (cell, $80) in
 * 8.8 and ($8000) as a fraction. Returns the list index, or -1 when none.
 */
export function nearestEnemy(
  ballXc: number, ballXf: number, ballYc: number, ballYf: number,
  enemies: ReadonlyArray<{ x: number; y: number }>,
): number {
  // $82:8EBE: |enemy - $D9F1| with $D9F1 = (x cell, fraction high byte),
  // not rounded (the 16-bit read straddles $D9F0/$D9F2)
  const bx = ((ballXc & 0xff) << 8) | (ballXf >> 8);
  const by = ((ballYc & 0xff) << 8) | (ballYf >> 8);
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < enemies.length; i++) {
    const ex = ((enemies[i].x & 0xff) << 8) | 0x80;
    const ey = ((enemies[i].y & 0xff) << 8) | 0x80;
    const dx = Math.abs(wrap16(ex - bx) >= 0x8000 ? wrap16(ex - bx) - 0x10000 : wrap16(ex - bx));
    const dy = Math.abs(wrap16(ey - by) >= 0x8000 ? wrap16(ey - by) - 0x10000 : wrap16(ey - by));
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
