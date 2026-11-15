/**
 * The default landing handler ($81:8905-$81:89A9), split into the two
 * halves the plan's schedule calls `dispatch-landing` and
 * `finish-landing`: the 4-frame hit-stop ($81:8C79) suspends the step
 * between them, after the reflection and before the damping
 * (physics.md "Hit-stop", emulated at web_fly 3114/3118).
 */
import { s16, wrap16, mulQ15s } from '../fixed';
import type { Ctx, Work } from './context';
import { reflect } from './reflect';
import { applyGravity } from './move';

/**
 * $D9B6, the shot's elevation (0 grounder, 60 fly shot, 65 Hi-Jump), lives
 * in the `Shot` trait; the kernels that test it take it as a parameter so
 * the work copy stays a pure mirror of $D9C6-$DA6E.
 */
export type ShotElev = number;

export type LandingOutcome =
  | { kind: 'gravity' }
  | { kind: 'hitstop'; frames: number; state: number }
  | { kind: 'rest' }
  | { kind: 'damp' };

/** $81:8C79: the landing hit-stop request, or null. A = the surface code. */
export function landingHitStop(w: Work): { frames: number; state: number } | null {
  if (w.hitStopLatch !== 0) return null;
  // $81:8C80 BPL / EOR / INC: |vz| as a 16-bit word (vz is stored unsigned)
  const mag = s16(w.vz) >= 0 ? w.vz : wrap16(-s16(w.vz));
  if (mag < 0x0900) return null;
  return { frames: 4, state: w.code };
}

/** $81:8C48: the step-hit hit-stop request, or null. A = edge + 9. */
export function stepHitStop(w: Work): { frames: number; state: number } | null {
  if (w.edge >= 2) return null; // CMP #$0002 / BCS: only edges 0 and 1
  const magX = s16(w.vx) >= 0 ? w.vx : wrap16(-s16(w.vx));
  const magY = s16(w.vy) >= 0 ? w.vy : wrap16(-s16(w.vy));
  if (wrap16(magX + magY) < 0x0300) return null; // the 16-bit ADC, an unsigned CMP
  return { frames: 2, state: w.edge + 9 };
}

/**
 * $81:8CE2: the fly shot's one-off spin impulse at the first landing
 * (modes 0 and 7). The $6AC0 presentation spawn ($81:9B61) is deferred
 * with the shot guide; the impulse itself is exact.
 */
export function spinImpulse(w: Work, shotElev: ShotElev): void {
  if (w.mode === 0x0a) return; // (the caller gates on mode; kept explicit)
  // $81:8CE2: a fly shot ($D9B6 != 0) with spin pending
  if (shotElev === 0 || w.spinPending === 0) return;
  w.vx = wrap16(w.vx + s16(w.spinX));
  w.vy = wrap16(w.vy + s16(w.spinY));
  w.spinPending = 0;
  w.spinX = 0;
  w.spinY = 0;
}

/** $81:899F: the shared gravity tail. */
export function gravityTail(w: Work): void {
  applyGravity(w);
}

/**
 * The first half, $81:8905-$81:895B: the crest lock-out, the ground test,
 * z = ground, the reflection, the bounced fact and the hit-stop request.
 * `$D9B6` (the shot's elevation, "is a fly shot") rides in `w.elev`.
 */
export function dispatchLanding(ctx: Ctx, w: Work, entry: 'full' | 'grounded' = 'full'): LandingOutcome {
  // $81:8905: the post-crest-launch bounce lock-out ($6A7A)
  if (entry === 'full' && w.launchLock !== 0) {
    w.launchLock += 1;
    if (w.launchLock >= 3) w.launchLock = 0;
    return { kind: 'gravity' }; // JMP $899F
  }
  // $81:891B: z >= ground (unsigned 32-bit) -> gravity only
  if (entry === 'full' && w.z >= w.ground) return { kind: 'gravity' };
  // loc_bounce $81:891B
  w.z = w.ground;
  // $81:8937: mode $0A skips the reflection
  if (w.mode !== 0x0a) {
    reflect(ctx.rules, w, w.code);
  }
  // $81:8946
  w.bounced = 1;
  if (w.mode === 0 || w.mode === 7) {
    const hs = landingHitStop(w);
    if (hs) return { kind: 'hitstop', frames: hs.frames, state: hs.state };
    spinImpulse(w, w.shotElev);
  }
  // $81:895F: spin is spent at the first landing, whichever kind it was
  w.spinPending = 0;
  // $81:8962: the 16-frame settle rule
  if (w.airFrames < ctx.rules.const_('bounceMinFrames')) return { kind: 'rest' };
  return { kind: 'damp' };
}

/**
 * The second half: the spin impulse (modes 0/7, after the hit-stop),
 * then the settle ($81:896B) or the damping ($81:8975) and the gravity
 * tail ($81:899F).
 */
export function finishLanding(ctx: Ctx, w: Work, outcome: LandingOutcome): void {
  switch (outcome.kind) {
    case 'gravity':
      gravityTail(w);
      return;
    case 'hitstop':
      // back from $81:8C79 at $81:895B: the spin impulse, then the same
      // settle rule as any landing ($81:8962): a ball airborne for fewer
      // than 16 frames comes to rest (web_warp_fly 2600: 15 frames after
      // the warp, a hit-stop and no bounce)
      if (w.mode === 0 || w.mode === 7) spinImpulse(w, w.shotElev);
      w.spinPending = 0;
      if (w.airFrames < ctx.rules.const_('bounceMinFrames')) rest(w);
      else dampAndGravity(w);
      return;
    case 'rest':
      rest(w);
      return;
    case 'damp':
      dampAndGravity(w);
      return;
  }
}

/** $81:896B: come to rest vertically and roll from here. */
function rest(w: Work): void {
  w.air = 0;
  w.vz = 0;
  w.airFrames = 0;
}

function dampAndGravity(w: Work): void {
  // the velocity is A, the factor X ($81:8975) - mulQ15s is not symmetric
  w.vx = mulQ15s(w.vx, w.dampXY);
  w.vy = mulQ15s(w.vy, w.dampXY);
  w.vz = mulQ15s(w.vz, w.dampZ);
  w.airFrames = 0;
  gravityTail(w);
}
