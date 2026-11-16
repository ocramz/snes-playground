/**
 * The copy abilities' presentation in the frame (sim/kirby-colours.ts):
 *
 * - `noteAbilityFx`, from the ability's facts (systems/ability.ts): the
 *   palette objects spawned (29, 36, 50, 27) and Fireball's set 5.
 * - `tickAbilityHud`, the HUD object's draw (`$84:99FA`), the first of
 *   list 4 in the thread tick: the outline, the icon's ground, the face.
 * - `tickAbilityColours`, the palette objects in the scheduler's order
 *   (list 4: 29, 36, then 27's exit; list 6: 50), before Kirby's script.
 * - `tickKirbyScriptColours`, after Kirby's script (systems/pose.ts
 *   kirbyScripts): the transformation's flash (state 8) and Freeze's set
 *   (state 36's first tick).
 *
 * They read the block as the scheduler finds it, between iterations.
 */
import type { World } from 'koota';
import type { Ctx } from '../sim/context';
import { BallAbility, BallMode, BallWet, BallWork, BallHoled } from '../traits/ball';
import { Pose } from '../traits/pose';
import { StockedAbility } from '../traits/counters';
import { findActivePlayer } from '../traits/player';
import { HoleFlow, type FlowPhase } from '../traits/flow';
import { AbilityFx, HUD_FACE, HUD_STANDING } from '../traits/ability-fx';
import { BallScreen } from '../traits/pose';
import { BallHeading } from '../traits/ball';
import { GameRng } from '../traits/water';
import { objectList, spawnObject, tickObject, type AbilityObject, type ObjectSource } from '../sim/ability-objects';
import { Reveal } from '../traits/reveal';
import { Warp } from '../traits/warp';
import { emitEvent } from './flow-util';
import { s16 } from '../fixed';
import {
  hudIconGround, hudOutline, OUTLINE, FIRST_COLOUR, set3, spawnBurnt, spawnSparkPal, spawnUfoPal,
  tickBurnt, tickSparkPal, tickUfoPal, transformFlash, writeColours, type HudSource,
} from '../sim/kirby-colours';

/** `$D842` is set by the set-up ($80:C679) and cleared as the roll starts ($82:C282). */
const STANDING: ReadonlySet<FlowPhase> = new Set(['ShotSetup', 'Aim', 'PanToShot', 'Spin', 'Power', 'LaunchDelay']);

const TRANSFORM_STATE = 8;
const FREEZE_STATE = 0x24;

/** The spawn arguments (`$531C`) of the objects spawned in a row: 32's four, 35's six. */
const SPAWN_ARGS: Record<number, number[]> = { 0x20: [6, 4, 2, 0], 0x23: [20, 16, 12, 8, 4, 0] };

/** The facts of an ability's code: the objects it spawned, a palette set. */
export function noteAbilityFx(world: World, ctx: Ctx, spawns: number[], paletteSet: number): void {
  const fx = world.get(AbilityFx);
  if (!fx) return;
  const seen: Record<number, number> = {};
  for (const type of spawns) {
    const n = seen[type] ?? 0;
    seen[type] = n + 1;
    // 21 at the point before this frame's projection ($80:E4B6 from $D972/$D97A, the last store's)
    if (DRAWN.has(type)) fx.objects.push(spawnObject(type, SPAWN_ARGS[type]?.[n] ?? 0, type === 0x15 ? kirbyPointNow(world, ctx) : undefined));
    if (type === 0x1d) fx.burnt = spawnBurnt();
    else if (type === 0x24) fx.spark = spawnSparkPal();
    else if (type === 0x32) fx.ufo = spawnUfoPal();
    else if (type === 0x1b) fx.frost = true;
    else if (type === 0x31) {
      fx.hud.ufo = { timer: 1, step: -1, digits: 1, started: false }; // $85:ADA0's init
      fx.ufoBody = { started: false, hum: 10, loop: 'A', holed: 4 };
    }
  }
  // $82:CA43: Fireball's set 5 ($80:D3DB), colours 2-7
  if (paletteSet === 5) writeColours(fx.colours, 2, ctx.rules.table('kirbyFire'));
}

/** Kirby's set 3 (`$80:D3AD`): the water's `$82:8604`, and the hole-out's set 2 (`$80:F495`). */
export function restoreKirbyColours(world: World, ctx: Ctx, wet: number): void {
  const fx = world.get(AbilityFx);
  if (fx) writeColours(fx.colours, 2, set3(ctx.rules, wet));
}

function hudSource(world: World): HudSource | null {
  const e = findActivePlayer(world);
  if (!e) return null;
  return {
    stock: e.get(StockedAbility)!.id,
    latch: s16(e.get(BallAbility)!.latch),
    lost: e.get(BallWork)!.lost,
    wet: e.get(BallWet)!.wet,
    state: e.get(Pose)!.state,
  };
}

/** The HUD object's draw: the outline (colour 7), the icon's ground, the face's countdown ($D862). */
export function tickAbilityHud(world: World, ctx: Ctx): void {
  const fx = world.get(AbilityFx);
  const h = hudSource(world);
  if (!fx || !h) return;
  const o = hudOutline(ctx.rules, h, fx.hud.outlinePhase);
  fx.colours[OUTLINE - FIRST_COLOUR] = o.colour;
  fx.hud.outlinePhase = o.phase;
  const g = hudIconGround(ctx.rules, h, fx.hud.iconPhase);
  fx.hud.ground = g.colour;
  fx.hud.iconPhase = g.phase;
  hudIcon(world, ctx, h);
}

/**
 * `$6AC0`, what the icon shows for stock 0: 1 from the shot thread's start
 * (`$81:BE97`, the aim's A), 2 in the roll (`$82:C027`), else 0 (the roll's
 * end `$80:F371`, the aim's head `$81:A619`).
 */
function hudMode(world: World): number {
  const phase = world.get(HoleFlow)!.phase;
  if (phase === 'Rolling') return 2;
  return SHOT_THREAD.has(phase) ? 1 : 0;
}

const SHOT_THREAD: ReadonlySet<FlowPhase> = new Set(['PanToShot', 'Spin', 'Power', 'LaunchDelay']);

/**
 * `$84:9B0F` (1P): the icon's upload when the stock, the latch or `$6AC0`
 * changed (`$84:9E07`[stock x 2 + 1 if spent]; stock 0 and not spent, out
 * of the roll: Kirby standing), the face of an ability-0 take for its 30
 * ticks first.
 */
function hudIcon(world: World, ctx: Ctx, h: HudSource): void {
  const hud = world.get(AbilityFx)!.hud;
  if (hud.face !== 0) {
    if (hud.face === 0x1e) hud.icon = HUD_FACE;
    hud.face -= 1;
    if (hud.face !== 0) return;
    hud.seenStock = 0x9999;
    hud.seenLatch = 0x9999;
  }
  const mode = hudMode(world);
  if (mode !== hud.seenMode) {
    hud.seenMode = mode;
    hud.seenStock = 0x9999;
    hud.seenLatch = 0x9999;
  }
  let changed = false;
  if (h.stock !== hud.seenStock) {
    changed = true;
    hud.seenStock = h.stock;
    hud.index = h.stock * 2;
  }
  if ((h.latch & 0xffff) !== hud.seenLatch) {
    changed = true;
    if (h.latch < 0) hud.index += 1; // $BA += 1 only when the latch changed this tick
    hud.seenLatch = h.latch & 0xffff;
  }
  if (!changed) return;
  hud.icon = hud.index === 0 && hud.seenMode !== 2 ? HUD_STANDING : ctx.rules.table('hudIcon')[hud.index] ?? HUD_STANDING;
}

/**
 * Object 49's countdown on the icon (`$84:A4E6`, its per-frame, not during
 * the cup's reveal or a warp): the UFO's picture and the seconds left
 * (`$D776` / 60, sfx $42) in turn, the halves `ufoCountdown` ticks long; the
 * UFO's picture at the table's 0 or once `$D77A` is set, and no more.
 */
function tickUfoCountdown(world: World, ctx: Ctx): void {
  const hud = world.get(AbilityFx)!.hud;
  const u = hud.ufo;
  const e = findActivePlayer(world);
  if (!u || !e) return;
  const w = e.get(BallWork)!;
  if (w.ufoLive === 0) {
    if (u.started) hud.ufo = null; // the object's end
    return;
  }
  u.started = true;
  if (world.get(Reveal)!.stage !== 'none' || world.get(Warp)!.stage !== 'none') return; // $6A8C, $6A06
  const stock = e.get(StockedAbility)!.id;
  const ufoIcon = (): number => ctx.rules.table('ufoIcon')[stock] ?? HUD_STANDING;
  if (w.d77a !== 0) {
    hud.icon = ufoIcon();
    hud.ufo = null;
    return;
  }
  u.timer -= 1;
  if (u.timer !== 0) return;
  u.step += 1;
  const t = ctx.rules.table('ufoCountdown')[u.step] ?? 0;
  if (t === 0) {
    hud.icon = ufoIcon();
    hud.ufo = null;
    return;
  }
  u.timer = t;
  u.digits ^= 1;
  if (u.digits === 0) hud.icon = ufoIcon();
  else {
    const digits = ctx.rules.table('ufoDigits');
    hud.icon = digits[Math.min(digits.length - 1, Math.floor(w.d776 / 60))];
    emitEvent(world, 'ability', 0x42); // $84:A54F (returns to $84:A553)
  }
}

/** The object types sim/ability-objects.ts runs. */
const DRAWN: ReadonlySet<number> = new Set([0x15, 0x1b, 0x1c, 0x1e, 0x20, 0x21, 0x23, 0x25, 0x26, 0x34, 0x41, 0x42]);

function kirbyPointNow(world: World, ctx: Ctx): { x: number; y: number } | undefined {
  const e = findActivePlayer(world);
  if (!e) return undefined;
  const sc = e.get(BallScreen)!;
  return { x: sc.x & 0xffff, y: (ctx.course.screenBase - sc.y) & 0xffff };
}

/** Kirby's point for the objects ($091E,X / $093E,X) and the block they read. */
function objectSource(world: World, ctx: Ctx): ObjectSource | null {
  const e = findActivePlayer(world);
  if (!e) return null;
  const sc = e.get(BallScreen)!;
  const w = e.get(BallWork)!;
  return {
    x: sc.x & 0xffff,
    y: (ctx.course.screenBase - sc.y) & 0xffff,
    d76c: w.d76c,
    mode: e.get(BallMode)!.mode,
    standing: STANDING.has(world.get(HoleFlow)!.phase),
    holed: e.get(BallHoled)!.holed,
    heading: e.get(BallHeading)!.deg,
    abilityDir: e.get(Pose)!.abilityDir,
    ride: w.waterWalk,
  };
}

/**
 * The drawn objects of one list (4, then 6 after the palette objects), in
 * slot order; what one spawns runs in the same tick (list 4's children are
 * list 4's).
 */
export function tickAbilityObjects(world: World, ctx: Ctx, list: number): void {
  const fx = world.get(AbilityFx);
  if (!fx || fx.objects.length === 0) return;
  const src = objectSource(world, ctx);
  if (!src) return;
  const rng = world.get(GameRng)!;
  const born: AbilityObject[] = [];
  for (const o of fx.objects) if (objectList(o.type) === list) born.push(...tickObject(ctx.rules, rng, o, src));
  for (let i = 0; i < born.length; i++) born.push(...tickObject(ctx.rules, rng, born[i], src));
  fx.objects = fx.objects.concat(born).filter((o) => !o.done);
}

/** The palette objects, in the scheduler's order. */
export function tickAbilityColours(world: World, ctx: Ctx): void {
  const fx = world.get(AbilityFx);
  const e = findActivePlayer(world);
  if (!fx || !e) return;
  const w = e.get(BallWork)!;
  const wet = e.get(BallWet)!.wet;
  if (fx.burnt) {
    const write = tickBurnt(ctx.rules, fx.burnt, w.d76c, wet);
    if (write) writeColours(fx.colours, write.from, write.words);
    if (fx.burnt.done) fx.burnt = null;
  }
  if (fx.spark) {
    const standing = STANDING.has(world.get(HoleFlow)!.phase);
    tickSparkPal(ctx.rules, fx.spark, w.d76c, standing, wet, fx.colours);
    if (fx.spark.done) fx.spark = null;
  }
  if (fx.frost) {
    // object 27's per-frame ($85:857C): gone when holed; on $D76C set 3 ($80:C958), gone
    if (e.get(BallHoled)!.holed !== 0) fx.frost = false;
    else if (w.d76c !== 0) {
      writeColours(fx.colours, 2, set3(ctx.rules, wet));
      fx.frost = false;
    }
  }
  tickUfoBody(world); // object 49 (list 6, spawned before 50): its thread, then its per-frame
  tickUfoCountdown(world, ctx);
  if (fx.ufo) {
    tickUfoPal(ctx.rules, fx.ufo, { mode: e.get(BallMode)!.mode, d76c: w.d76c, d77a: w.d77a, d776: w.d776, wet }, fx.colours);
    if (fx.ufo.done) fx.ufo = null;
  }
}

/**
 * Object 49's thread, its sounds (`$85:ADA0`): flying, the hum $75 every 10
 * ticks (not while `$D76C`, the cup's reveal or a warp holds); `$D77A` = 1,
 * $73; then, or at `$D77A` = 2, $74; past that, once holed, sound 0 and 4
 * ticks later $21 (`$85:AE63`). It ends with the object (`$D76C`, or the
 * mode no longer 10).
 */
function tickUfoBody(world: World): void {
  const fx = world.get(AbilityFx)!;
  const b = fx.ufoBody;
  const e = findActivePlayer(world);
  if (!b || !e) return;
  const w = e.get(BallWork)!;
  const sfx = (id: number): void => emitEvent(world, id === 0 ? 'silence' : 'ability', id);
  if (!b.started) b.started = true;
  else if (b.loop === 'A') {
    b.hum -= 1;
    if (b.hum === 0) {
      b.hum = 10;
      const held = w.d76c !== 0 || world.get(Reveal)!.stage !== 'none' || world.get(Warp)!.stage !== 'none';
      if (!held) sfx(0x75); // $85:AE13
    }
    if (w.d77a === 1) {
      sfx(0x73); // $85:AE26
      b.loop = 'B';
    } else if (w.d77a !== 0) {
      sfx(0x74); // $85:AE4E
      b.loop = 'C';
    }
  } else {
    if (e.get(BallHoled)!.holed !== 0 && b.holed >= 0) {
      if (b.holed === 4) sfx(0); // $85:AE88
      b.holed -= 1;
      if (b.holed < 0) sfx(0x21);
    }
    if (b.loop === 'B' && w.d77a !== 1) {
      sfx(0x74);
      b.loop = 'C';
    }
  }
  if (w.d76c !== 0 || e.get(BallMode)!.mode !== 0x0a) fx.ufoBody = null; // its per-frame's end
}

/** Kirby's script's sounds the engine runs: Parasol's opening $44 (state 29, `$87:8572`). */
const PARASOL_OPEN = 0x1d;
const PARASOL_OPEN_TICK = 6;

/** Kirby's script's colour writes, after its tick. */
export function tickKirbyScriptColours(world: World, ctx: Ctx): void {
  const fx = world.get(AbilityFx);
  const e = findActivePlayer(world);
  if (!fx || !e) return;
  const pose = e.get(Pose)!;
  if (pose.scriptState === PARASOL_OPEN && pose.scriptT === PARASOL_OPEN_TICK) emitEvent(world, 'ability', 0x44);
  if (pose.scriptState === TRANSFORM_STATE) {
    // the script's first tick is the iteration's after the trigger's, which
    // the engine runs a frame earlier (its state 8 leads by one): tick k at scriptT k + 2
    const write = transformFlash(ctx.rules, e.get(BallMode)!.mode, pose.scriptT - 2);
    if (write) writeColours(fx.colours, write.from, write.words);
  } else if (pose.scriptState === FREEZE_STATE && pose.scriptT === 2) {
    writeColours(fx.colours, 2, ctx.rules.table('kirbyFreeze')); // $87:8301
  }
}

/** The hole's start: set 3, no palette object. */
export function resetAbilityFx(world: World, ctx: Ctx): void {
  const fx = world.get(AbilityFx);
  if (!fx) return;
  fx.colours = set3(ctx.rules, 0);
  fx.burnt = null;
  fx.spark = null;
  fx.ufo = null;
  fx.frost = false;
  fx.hud.face = 0;
  fx.hud.ufo = null;
  fx.objects = [];
  fx.ufoBody = null;
}
