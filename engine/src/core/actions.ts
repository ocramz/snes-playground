/**
 * The core actions (plans/port_v1_koota_phaser4.md "Actions") — the write
 * API the hosts (the Phaser bridge, the test harness, a debug UI) call
 * between frames:
 *
 * - `startCourse(rules, holes)`: a new course (`$80:C0C5`: hole 0, the card
 *   cleared, at least 2 lives, 4 tomatoes), then its first hole;
 * - `startHole(i)`: hole i at its shot set-up, with its entities (the tee,
 *   the enemies, the pillars, the hazard actors) under a fresh hole root;
 * - `nextHole()`: after the hole-out (the RESULT card's button, `$83:D495`),
 *   the next hole, or CourseDone after the last;
 * - `continueGame()` / `endGame()`: GAME OVER's two answers (`$83:D856`);
 * - `pause()` / `resume()`: `IsPaused` on the world skips the core frame;
 * - `placeBall`: the poke equivalent the trace tests seed from.
 */
import type { World } from 'koota';
import { BallPos, BallVel, BallAir, BallSpin, StillCount, Modifier, BallHoled } from './traits/ball';
import { Shot } from './traits/shot';
import { BallWork, type BallWorkFields, emptyWork } from './traits/ball';
import { HoleFlow } from './traits/flow';
import { Camera } from './traits/camera';
import { Guide } from './traits/guide';
import { Pose, BallScreen, BallSprite, PRIO_OVER } from './traits/pose';
import { Course, setCourse, courseEntity } from './traits/course';
import { Stall } from './traits/stall';
import { Reveal } from './traits/reveal';
import { Warp } from './traits/warp';
import { Time } from './traits/time';
import { Session, IsPaused } from './traits/session';
import {
  IsHole, HoleInfo, InHole, Cell, IsTee, IsEnemy, EnemyKind, Hover, IsPillar,
  IsHazardActor, ActorType,
} from './traits/hole';
import { Visual } from './traits/visual';
import {
  Tomatoes, Strokes, Stars, StockedAbility, Career, TomatoQueue,
  TOMATO_MAX, START_LIVES, CONTINUE_LIVES,
} from './traits/counters';
import { probe } from './sim/probe';
import { kernelCourse, type Ctx } from './sim/context';
import { project } from './projection';
import type { CourseData } from './course-data';
import type { RomRules } from './rules';
import { sweepActors, type HoleActors } from './sweep';
import { setupHazards } from './systems/actors';
import { spawnPlayer } from './world';
import { IsPlayer, activePlayer } from './traits/player';
import { BoostHum } from './traits/boost';
import { SnapTrail } from './traits/snap';

export interface BallPlacement {
  xc: number; xf: number; yc: number; yf: number; z: number;
  vx: number; vy: number; vz: number;
  air: number;
  aim?: number;
  elev?: number;
  spinX?: number; spinY?: number; spinPending?: number;
}

export function placeBall(world: World, p: BallPlacement, ctx?: Ctx): void {
  const e = activePlayer(world);
  e.set(BallPos, { xc: p.xc, xf: p.xf, yc: p.yc, yf: p.yf, z: p.z });
  e.set(BallVel, { vx: p.vx, vy: p.vy, vz: p.vz });
  e.set(BallAir, { air: p.air });
  if (p.spinX !== undefined || p.spinY !== undefined || p.spinPending !== undefined) {
    e.set(BallSpin, {
      sx: p.spinX ?? 0,
      sy: p.spinY ?? 0,
      pending: p.spinPending ?? 0,
    });
  }
  const shot = world.get(Shot)!;
  world.set(Shot, {
    ...shot,
    aim: p.aim ?? shot.aim,
    elev: p.elev ?? shot.elev,
  });
  // the placement clears the shot-over state, as a poke does
  e.set(StillCount, { over: 0, frames: 0 });
  e.set(Modifier, { kind: -1, window: 0, timer: 0 });
  const c = ctx ?? world.get(Session)!.ctx ?? undefined;
  if (c) {
    // Seed the work copy's probe fields (the ROM's block carries them at
    // $D8C2-$D8DE; a poke that skips them leaves the first step's z at the
    // stale ground). The next begin-ball-step copies them to "previous".
    const w = e.get(BallWork)! as BallWorkFields;
    w.xc = p.xc; w.xf = p.xf; w.yc = p.yc; w.yf = p.yf; w.z = p.z;
    w.vx = p.vx; w.vy = p.vy; w.vz = p.vz; w.air = p.air;
    probe(c, w);
  }
  // a placed ball is in play: the roll's systems run from the next frame
  const flow = world.get(HoleFlow)!;
  if (flow.phase !== 'HoleOut') {
    world.set(HoleFlow, { ...flow, phase: 'Rolling', since: world.get(Time)!.frame });
  }
}

/** The context the schedule runs the current hole with (null before a hole). */
export function sessionCtx(world: World): Ctx | null {
  return world.get(Session)?.ctx ?? null;
}

/**
 * A new course (`$80:C0C5`, reached from the course map and from CONTINUE):
 * the card cleared, at least 2 lives ($80:C101), 4 tomatoes ($80:C122), the
 * tomato queue empty; then hole 0. Returns the context for its first hole.
 */
export function startCourse(world: World, rules: RomRules, courses: CourseData[]): Ctx {
  if (courses.length === 0) throw new Error('startCourse with no holes');
  const s = world.get(Session)!;
  s.rules = rules;
  s.courses = courses;
  const career = world.get(Career)!;
  career.lives = Math.max(career.lives, START_LIVES);
  career.card = courses.map(() => -1);
  const q = world.get(TomatoQueue)!;
  q.entries = []; q.pending = null; q.timer = 0; q.hold = 0;
  if (world.queryFirst(IsPlayer) === undefined) spawnPlayer(world);
  activePlayer(world).set(Tomatoes, { n: TOMATO_MAX });
  return startHole(world, 0);
}

/**
 * Start hole `i` of the loaded course at its shot set-up ($80:C15F's
 * per-hole resets): the previous hole's entities destroyed; the hole's own
 * spawned from the actor sweep; the ball on the tee's centre, grounded and
 * still, its ground probed; strokes 1 ($80:C1DC), stars 0; tomatoes carry
 * over (1P, $80:C1B5); Kirby's screen position the tee's projection
 * (integers only: $80:F73B loads $DA58/$DA5C, the fractions start at 0);
 * the camera centred on him (192, 304 on hole 1, as the intro leaves it;
 * docs/web-demo.md "The intro").
 */
export function startHole(world: World, i: number): Ctx {
  const s = world.get(Session)!;
  if (!s.rules) throw new Error('startHole before startCourse');
  const data = s.courses[i];
  if (!data) throw new Error(`no hole ${i}`);
  for (const root of world.query(IsHole)) root.destroy();
  setCourse(world, data);
  const course = courseEntity(world).get(Course)!;
  const ctx: Ctx = {
    rules: s.rules,
    course: { ...kernelCourse(data), layer2: course.layer2 },
    presentation: true,
  };
  s.holeIndex = i;
  s.ctx = ctx;
  if (world.queryFirst(IsPlayer) === undefined) spawnPlayer(world);
  const e = activePlayer(world);
  // a fresh work copy: the set-up's coefficients ($80:C688)
  e.set(BallWork, emptyWork());
  const w = e.get(BallWork)!;
  w.xc = data.tee.x; w.xf = 0x8000;
  w.yc = data.tee.y; w.yf = 0x8000;
  w.air = 0;
  probe(ctx, w);
  w.z = w.ground;
  e.set(BallPos, { xc: w.xc, xf: w.xf, yc: w.yc, yf: w.yf, z: w.z });
  e.set(BallVel, { vx: 0, vy: 0, vz: 0 });
  e.set(BallAir, { air: 0 });
  e.set(BallSpin, { sx: 0, sy: 0, pending: 0 });
  e.set(BallHoled, { holed: 0 });
  e.set(StillCount, { over: 0, frames: 0 });
  e.set(Modifier, { kind: -1, window: 0, timer: 0 });
  e.set(Pose, { state: 0, facing: 0, angle: 0, variant: 0, timer: 0, resume: 0 });
  e.set(Strokes, { n: 1 });
  e.set(Stars, { n: 0 });
  e.set(StockedAbility, { id: 0 });
  const p = project(ctx.course, w.xc, w.xf, w.yc, w.yf, w.z);
  e.set(BallScreen, { x: p.x, xf: 0, y: p.y, yf: 0, px: p.x, pxf: 0, py: p.y, pyf: 0 });
  e.set(BallSprite, { prio: PRIO_OVER });
  world.set(Shot, {
    ...world.get(Shot)!,
    aim: 0xffff, elev: 0xffff, // $80:F78F/$80:F795 at the hole's start
    side: 0, topBack: 0, guideSide: 6, guideTB: 6, // power-on RAM; the set-up copies 6
    meter: 0, meterDir: 1, power: 0, guideEnds: 0,
  });
  world.set(Camera, {
    x: (p.x - 0x80) & 0xffff, y: (p.y + 0x70) & 0xffff,
    wantX: 0, wantY: 0, lagX: 0, lagY: 0, mode: 0,
    targetX: 0, targetY: 0, arrived: 0,
  });
  const g = world.get(Guide)!;
  g.points = []; g.ends = []; g.steps = 0; g.pendingFrame = -1;
  world.set(Stall, { ...world.get(Stall)!, kind: 'none', framesLeft: 0, resumeAt: -1 });
  world.set(Reveal, { ...world.get(Reveal)!, stage: 'none', t: 0, total: 0 });
  world.set(Warp, { ...world.get(Warp)!, stage: 'none', t: 0, hidden: 0 });
  const actors = spawnHoleEntities(world, s.rules, data, i);
  setupHazards(world, ctx, actors); // $82:B9C7, $82:BA87 (after the sweep)
  // $82:BCD7: a boost panel anywhere spawns object 112, whose hook hums
  // (systems/boost-hum.ts); its $6A28 starts at 0 (the fresh work copy)
  world.set(BoostHum, { active: data.tile.some((t) => t >= 0x30 && t < 0x3c) ? 1 : 0, counter: 0 });
  // objects 61 and 62, the snap panels' stars (systems/snap-trail.ts)
  const trail = world.get(SnapTrail)!;
  trail.keep = 0xffff; trail.spawners = []; trail.stars = [];
  // the first core frame after this is the set-up's first
  world.set(HoleFlow, { phase: 'ShotSetup', since: world.get(Time)!.frame + 1, prev: 'Idle', holeInOne: 0, length: 0 });
  return ctx;
}

/** The hole root and its entities, from the load-time sweep ($82:B320). */
function spawnHoleEntities(world: World, rules: RomRules, data: CourseData, index: number): HoleActors {
  const root = world.spawn(IsHole, HoleInfo({ index, name: data.name ?? '' }));
  const actors = sweepActors(rules, { w: data.w, h: data.h, tile: data.tile });
  world.spawn(IsTee, Cell({ x: data.tee.x, y: data.tee.y }), Visual({ kind: 'tee' }), InHole(root));
  for (const en of actors.enemies) {
    world.spawn(
      IsEnemy,
      Cell({ x: en.x, y: en.y }),
      EnemyKind({ tile: en.tile, species: en.species, ability: en.ability, listIndex: en.listIndex }),
      Hover({ steps: en.hover }),
      Visual({ kind: 'enemy' }),
      InHole(root),
    );
  }
  for (const p of actors.pillars) {
    world.spawn(IsPillar, Cell({ x: p.x, y: p.y }), Visual({ kind: 'pillar' }), InHole(root));
  }
  for (const h of actors.hazards) {
    world.spawn(
      IsHazardActor,
      ActorType({ type: h.type, tile: h.tile }),
      Cell({ x: h.x, y: h.y }),
      Visual({ kind: 'hazard' }),
      InHole(root),
    );
  }
  return actors;
}

/**
 * The RESULT card's button (`$83:D495`, then `$80:F4F0` INC $6A5E): the
 * next hole, or CourseDone after the last. Returns the new hole's context,
 * or null when the course is over.
 */
export function nextHole(world: World): Ctx | null {
  const s = world.get(Session)!;
  const i = s.holeIndex + 1;
  if (i >= s.courses.length) {
    for (const root of world.query(IsHole)) root.destroy();
    const flow = world.get(HoleFlow)!;
    world.set(HoleFlow, { ...flow, phase: 'CourseDone', since: world.get(Time)!.frame, prev: flow.phase });
    return null;
  }
  return startHole(world, i);
}

/**
 * GAME OVER's CONTINUE (`$80:F486`: lives 2, then `$80:F1E7` -> `$80:C0C5`):
 * the course again from its first hole, with 4 tomatoes.
 */
export function continueGame(world: World): Ctx {
  const s = world.get(Session)!;
  if (!s.rules) throw new Error('continueGame before startCourse');
  world.get(Career)!.lives = CONTINUE_LIVES;
  return startCourse(world, s.rules, s.courses);
}

/** GAME OVER's GAME END (`$80:F120`, the title): the hole torn down. */
export function endGame(world: World): void {
  for (const root of world.query(IsHole)) root.destroy();
  const s = world.get(Session)!;
  s.holeIndex = -1;
  s.ctx = null;
  const flow = world.get(HoleFlow)!;
  world.set(HoleFlow, { ...flow, phase: 'Idle', since: world.get(Time)!.frame, prev: flow.phase });
}

export function pause(world: World): void {
  if (!world.has(IsPaused)) world.add(IsPaused);
}

export function resume(world: World): void {
  if (world.has(IsPaused)) world.remove(IsPaused);
}
