/**
 * The snap panels' star trail: thread objects 61 and 62 (read 2026-11-15;
 * docs/animation.md "Objects 61 and 62", notes/port-v2-phase3-snaps.md).
 * Pure: the systems (systems/snap-trail.ts) feed it the ball and keep the
 * runs in the `SnapTrail` trait; the view (game/features/env/
 * snap-stars-view.ts) draws the stars.
 *
 * Object 61 ($85:CF2D), spawned by a snap push with the latch clear
 * (sim/dispatch.ts snapPush, `$82:A60E`), never draws. Its loop:
 *
 *     $699A = $FFFF; $CF4E (the burst); yield 7   ; 8 ticks
 *     if $699A != 0: exit                          ; no push since: STZ $699A
 *
 * `$CF4E`: on a snap tile ($DA0A in $18-$1B) with the block's velocity along
 * the panel's arrow ($18 vy < 0, $19 vx >= 0, $1A vy >= 0, $1B vx < 0), four
 * stars, `$531C` = 3, 2, 1, 0, at the ball's projected point ($091E,X /
 * $093E,X = $DA58, $8B9A - $DA5C), heading `$D9DE`, OAM queue Kirby's
 * `$0B1E,X` + 1 when dir16 < 3 or >= 11.
 *
 * Object 62 ($85:CFE1) clears its motion ($80:E710) and runs one of 64
 * scripts by heading and variant (tables.json `snapStars`, from
 * `$85:CFF2`): `JSR $1104` sets the motion, `JSR $1030 idx,n` shows a frame
 * of table `$89:9485` (idx $FF hides) and yields n, then `$80:E060` ends it.
 * Its draw routine `$80:E96C` moves it first ($80:E97C, `polar` below) and
 * then integrates and draws ($80:E55A -> $80:E5E2, y then x), every tick it
 * lives, hidden or not; the exit tick does neither.
 *
 * The scheduler ($80:E0C0): a thread runs when its wait underflows (a yield
 * of n resumes n + 1 ticks on); a slot spawned during the tick runs its
 * thread and its draw in the same tick.
 */
import type { RomRules } from '../rules';
import { s16, wrap16 } from '../fixed';

/** One star (object 62): its slot fields. Positions are 16-bit patterns, as the ROM keeps them. */
export interface StarRun {
  dir: number; // $589C, the heading 0-15 at the burst
  variant: number; // $531C, 3 2 1 0 in spawn order
  /** $0B1E,X's +1 ($85:CFB9): the star sorts one OAM queue behind Kirby's. */
  queueAdd: number;
  x: number; xf: number; // $5F1C / $601C, the bitmap's x, 16.16
  y: number; yf: number; // $5F9C / $609C, the bitmap's y (down)
  a1: number; a1Rate: number; // $5A1C (angle in the high byte) / $5A9C
  speed: number; speedRate: number; // $5B1C (8.8 px) / $5B9C
  a2: number; accel: number; // $5C1C / $5D1C
  speed2: number; // $5C9C: the speed accumulated along a2
  frame: number; // $5D9C, -1 hidden
  wait: number; // $529C
  pc: number; // the next op in tables.json `snapStars`
  /** Ticks lived, and the burst's point (the ball's), for the views and the tests. */
  age: number;
  ox: number; oy: number;
  done: boolean;
}

/** One object 61. */
export interface SpawnerRun {
  wait: number; // $529C
  started: boolean;
  done: boolean;
}

/** `$80:EA26`: the polar step, (r, angle) -> (dx, dy) in 8.8 px, from `$80:EABA`. */
export function polar(rules: RomRules, r: number, angle: number): [number, number] {
  const t = rules.table('polarTrig');
  const r6 = s16(r) >> 6; // LSR x6, or SEC/ROR x6 when negative
  const part = (c: number): number => wrap16(s16(Math.imul(r6, c) & 0xffff) >> 2); // $80:EA76, then the two shifts
  return [part(t[angle & 0xff]), part(t[(angle & 0xff) + 64])];
}

export function spawnStar(rules: RomRules, dir: number, variant: number, x: number, y: number, queueAdd: number): StarRun {
  const table = rules.table('snapStars');
  return {
    dir, variant, queueAdd,
    x: x & 0xffff, xf: 0, y: y & 0xffff, yf: 0, // $80:E4F2 zeroes the fractions
    a1: 0, a1Rate: 0, speed: 0, speedRate: 0, a2: 0, accel: 0, speed2: 0, // $80:E710
    frame: -1, // $80:E4F2: $5D9C = $FFFF
    wait: 0, // $80:DFBA: runs on its spawn tick
    pc: table[(dir & 15) * 4 + (variant & 3)],
    age: 0, ox: x & 0xffff, oy: y & 0xffff,
    done: false,
  };
}

/**
 * One scheduler tick of a star: its thread when due, then its draw's motion
 * (not on the exit tick). `between` sees it between the two: a tick can
 * straddle a frame of the recording (as tickActor's).
 */
export function tickStar(rules: RomRules, s: StarRun, between?: (s: StarRun) => void): void {
  if (s.done) return;
  s.age += 1;
  s.wait -= 1;
  if (s.wait < 0) runScript(rules, s);
  if (s.done) return; // $80:E060 freed the slot before the draw pass
  between?.(s);
  move(rules, s);
}

function runScript(rules: RomRules, s: StarRun): void {
  const ops = rules.table('snapStars');
  for (;;) {
    switch (ops[s.pc]) {
      case 1: // JSR $1104 ($80:E861): the bytes land in the high byte
        s.a1 = (ops[s.pc + 1] << 8) & 0xffff;
        s.a1Rate = ops[s.pc + 2];
        s.speed = (ops[s.pc + 3] << 8) & 0xffff;
        s.speedRate = ops[s.pc + 4];
        s.a2 = (ops[s.pc + 5] << 8) & 0xffff;
        s.accel = ops[s.pc + 6];
        s.speed2 = 0;
        s.pc += 7;
        break;
      case 2: // JSR $1030 ($80:E78D): show idx, yield n
        s.frame = ops[s.pc + 1] === 0xff ? -1 : ops[s.pc + 1];
        s.wait = ops[s.pc + 2];
        s.pc += 3;
        return;
      default: // LDY $D2 / JML $80:E060
        s.done = true;
        return;
    }
  }
}

/** `$80:E97C` then `$80:E5E2`. ($591C/$599C, a constant velocity, stay 0 for object 62.) */
function move(rules: RomRules, s: StarRun): void {
  let vx = 0;
  let vy = 0;
  if (s.speed !== 0) [vx, vy] = polar(rules, s.speed, s.a1 >> 8);
  if ((s.a1 | s.speed) !== 0) {
    s.a1 = wrap16(s.a1 + s.a1Rate); // stepped after use
    s.speed = wrap16(s.speed + s.speedRate);
  }
  if (s.accel !== 0) {
    const [dx, dy] = polar(rules, s.speed2, s.a2 >> 8);
    vx = wrap16(vx + dx);
    vy = wrap16(vy + dy);
    s.speed2 = wrap16(s.speed2 + s.accel);
  }
  // $611C = the high byte sign-extended, $621C = the low byte << 8; y first
  const y = add(s.y, s.yf, vy);
  s.y = y[0]; s.yf = y[1];
  const x = add(s.x, s.xf, vx);
  s.x = x[0]; s.xf = x[1];
}

function add(whole: number, frac: number, v: number): [number, number] {
  const f = frac + ((v & 0xff) << 8);
  const hi = (v & 0x8000) !== 0 ? (v >> 8) | 0xff00 : v >> 8;
  return [wrap16(whole + hi + (f >> 16)), f & 0xffff];
}

/** What object 61 reads of the ball at its tick. */
export interface StarSource {
  tile: number; // $DA0A
  vx: number; vy: number; // the block's $D87A / $D87E
  dir16: number; // $D9DE
  x: number; y: number; // $091E,X / $093E,X: the projected point in bitmap pixels
}

/** `$85:CF4E`: the burst, or none. */
export function burst(rules: RomRules, b: StarSource): StarRun[] {
  const t = b.tile;
  if (t < 0x18 || t >= 0x1c) return [];
  const along = [s16(b.vy) < 0, s16(b.vx) >= 0, s16(b.vy) >= 0, s16(b.vx) < 0][t - 0x18];
  if (!along) return [];
  const queueAdd = b.dir16 < 3 || b.dir16 >= 11 ? 1 : 0; // $85:CFB9-$85:CFC3
  const out: StarRun[] = [];
  for (let v = 3; v >= 0; v--) out.push(spawnStar(rules, b.dir16, v, b.x, b.y, queueAdd));
  return out;
}

/**
 * One scheduler tick of object 61. `keep` is `$699A` (shared by every live
 * object 61; the push clears it); returns its new value and the stars spawned.
 */
export function tickSpawner(rules: RomRules, s: SpawnerRun, keep: number, ball: StarSource): { keep: number; stars: StarRun[] } {
  if (s.done) return { keep, stars: [] };
  s.wait -= 1;
  if (s.wait >= 0) return { keep, stars: [] };
  if (s.started && keep !== 0) {
    s.done = true; // $85:CF46: no push in the 8 ticks
    return { keep, stars: [] };
  }
  s.started = true;
  const stars = burst(rules, ball); // $85:CF2D: $699A = $FFFF first
  s.wait = 7; // $85:CF3F
  return { keep: 0xffff, stars };
}

export function newSpawner(): SpawnerRun {
  return { wait: 0, started: false, done: false };
}
