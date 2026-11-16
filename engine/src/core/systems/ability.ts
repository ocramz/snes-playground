/**
 * The copy abilities' facts into the world (sim/abilities.ts writes them on
 * the work copy; notes/port-v2-phase5-abilities.md): Kirby's state and the
 * poses' switch variables, the inline sounds, the effect objects, Spark's
 * destroyed cell, Hi-Jump's relaunch of the shot's aim and elevation.
 * Called by the step's entries that run ability code, right after it, so
 * the order of the sounds is the ROM's.
 */
import type { World } from 'koota';
import { BallWork, BallMode, BallVel, BallSpin, type BallWorkFields } from '../traits/ball';
import type { Entity } from 'koota';
import { Pose } from '../traits/pose';
import { Shot } from '../traits/shot';
import { Time } from '../traits/time';
import { Hazards } from '../traits/hazards';
import { Course, courseEntity } from '../traits/course';
import { Cell, IsPillar } from '../traits/hole';
import { Visual } from '../traits/visual';
import { activePlayer, findActivePlayer } from '../traits/player';
import { emit } from '../events';
import type { Ctx } from '../sim/context';
import { rollPoseState } from './panel';
import { noteAbilityFx } from './ability-fx';

export function applyAbilityFacts(world: World, ctx: Ctx, w: BallWorkFields): void {
  const e = activePlayer(world);
  const api = { frame: world.get(Time)!.frame };
  const pose = e.get(Pose)!;
  let state = pose.state;
  if (w.rollPoseFromSpin !== 0) {
    // $82:C808 (Spark with a spin pending): the roll pose by the latched spin
    w.rollPoseFromSpin = 0;
    const shot = world.get(Shot)!;
    state = rollPoseState(shot.rollSide, shot.rollTB, shot.grounder !== 0);
  }
  if (w.poseState >= 0) {
    state = w.poseState;
    w.poseState = -1;
  }
  if (state !== pose.state || pose.abilityVar !== w.abilityVar || pose.abilityDir !== w.abilityDir) {
    e.set(Pose, { ...pose, state, timer: state !== pose.state ? 0 : pose.timer, abilityVar: w.abilityVar, abilityDir: w.abilityDir });
  }
  for (const sfx of w.abilitySfx) emit(world, api, sfx === 0 ? 'silence' : 'ability', sfx);
  w.abilitySfx = [];
  noteAbilityFx(world, ctx, w.abilitySpawn, w.paletteSet);
  for (const type of w.abilitySpawn) {
    emit(world, api, 'ability-fx', -1, type);
    if (type === 0x33) w.parasol = PARASOL_FRESH; // object 51, the parasol (logic: abilityThreads)
  }
  w.abilitySpawn = [];
  if (w.paletteSet >= 0) {
    emit(world, api, 'palette-set', -1, w.paletteSet); // $80:D2FE
    w.paletteSet = -1;
  }
  if (w.destroyCell >= 0) {
    destroyCell(world, ctx, w.destroyCell);
    w.destroyCell = -1;
  }
  if (w.relaunch !== 0) {
    // $82:CC43: $D9B4 = the heading, $D9B6 = 65, $6AD8 = 0 for the rest of the shot
    w.relaunch = 0;
    world.set(Shot, { ...world.get(Shot)!, aim: w.shotAim, elev: w.shotElev, grounder: 0 });
  }
}

/**
 * `$82:EE9A`, Spark's destroy: the cell's actor record unlinked and its
 * layer-2 tile cleared (the kernels share the array). The tree's object 72
 * breaks ($531C = $FFFF); a volcano's object is told to go ($579C = 1) and
 * object $3C takes its place (sim/hazards.ts spawns it in the facts).
 */
function destroyCell(world: World, ctx: Ctx, cell: number): void {
  const course = courseEntity(world).get(Course)!;
  course.layer2[cell] = 0;
  ctx.course.layer2[cell] = 0;
  const x = cell % ctx.course.w;
  const y = Math.floor(cell / ctx.course.w);
  for (const p of world.query(IsPillar, Cell)) {
    const c = p.get(Cell)!;
    if (c.x === x && c.y === y) p.set(Visual, { kind: 'pillar-broken' });
  }
  const f = world.get(Hazards);
  if (f && f.atCell.length > cell && f.atCell[cell] >= 0) {
    const a = f.actors[f.atCell[cell]];
    f.atCell[cell] = -1;
    a.co = null;
    a.frame = 0xffff;
  }
}

/** Object 51 just spawned: its first tick picks its variant. */
export const PARASOL_FRESH = -2;
/** Object 51's fall branch ($85:B41F). */
export const PARASOL_FALL = 3;

/**
 * The effect objects whose code is game logic, ticked in the thread phase
 * (systems/counters.ts threadTick); their Kirby states show from the next
 * frame (`Pose.pending`):
 *
 * - object 51, the parasol (`$85:B2FC`): by Parasol's phase $D778 it shows
 *   Kirby's state 2 (rolling fast, unless a hit code is in the mode), 30
 *   (open), or 30 (slow, the same proviso); each tick it ends once the mode
 *   is not 2 or $D76C is set (`$85:B713`); open and the ball lost below
 *   the course (`$D876` bit 0) it falls (`$85:B41F`): state 31, the block's
 *   gravity $FFC0, vz 0, mode 0 — until the mode is set again or $D76C;
 * - object 49, the UFO's body (`$85:AEA8`): while the timer $D762 is 0 it
 *   zeroes the block's vx and vy; it ends when $D76C is set or the mode is
 *   not 10.
 */
export function abilityThreads(world: World): void {
  const e = findActivePlayer(world);
  if (e === undefined) return;
  const w = e.get(BallWork)!;
  // object 25, the spin streak ($84:891A): it ends, and with it the first
  // bounce's sound $68F0, once the block's spin is 0 (the trigger clears it:
  // demo 19, 3075) or the ball is lost
  if (w.spinBounceSfx !== 0) {
    const spin = e.get(BallSpin)!;
    if ((spin.sx | spin.sy) === 0 || (w.lost & 1) !== 0) w.spinBounceSfx = 0;
  }
  const mode = e.get(BallMode)!.mode;
  if (w.parasol !== -1) parasolTick(e, w, mode);
  if (w.ufoLive !== 0) {
    if (w.d76c !== 0 || mode !== 0x0a) w.ufoLive = 0;
    else if (w.d762 === 0) {
      const v = e.get(BallVel)!;
      e.set(BallVel, { ...v, vx: 0, vy: 0 });
      w.vx = 0;
      w.vy = 0;
    }
  }
}

function parasolTick(e: Entity, w: BallWorkFields, mode: number): void {
  const pose = e.get(Pose)!;
  const show = (state: number): void => e.set(Pose, { ...e.get(Pose)!, pending: state });
  if (w.parasol === PARASOL_FALL) {
    if (mode !== 0 || w.d76c !== 0) w.parasol = -1; // the end: object 52 ($85:B751)
    return;
  }
  if (w.parasol !== PARASOL_FRESH && (mode !== 2 || w.d76c !== 0)) {
    w.parasol = -1; // $85:B713 -> $85:B735: the end
    return;
  }
  const phase = w.d778;
  if (phase >= 3) throw new Error(`$85:B30E: parasol phase ${phase} hangs`);
  if (phase !== w.parasol) {
    w.parasol = phase;
    if (phase === 0) { if (mode < 0x0c) show(2); } // $85:B4D2
    else if (phase === 1) show(0x1e); // $85:B342
    else if (mode < 0x0c) show(0x1e); // $85:B63F
  }
  if (w.parasol === 1 && (w.lost & 1) !== 0) {
    // $85:B41F: the fall
    w.parasol = PARASOL_FALL;
    show(0x1f);
    w.gravity = 0xffc0;
    const v = e.get(BallVel)!;
    e.set(BallVel, { ...v, vz: 0 });
    w.vz = 0;
    e.set(BallMode, { mode: 0 });
    w.mode = 0;
  }
  void pose;
}
