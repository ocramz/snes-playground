/**
 * Plays a planned shot through the whole world (every system of the frame,
 * the flow's phases, the takes, the reveal, the warp's stall): the fidelity
 * check of the random holes' silent shot simulator (src/core/gen/shot-sim.ts).
 *
 * The aim stage takes the aim and the shot kind as set; the spin stage is
 * passed with A; in the power stage the meter is set and A latches it on the
 * same frame ($81:C035: "latched as it is"), with the selectors at 6.
 */
import { Shot } from '../src/core/traits/shot';
import { BallPos, BallHoled, BallWork } from '../src/core/traits/ball';
import { activePlayer } from '../src/core/traits/player';
import { POWER_FIRST } from '../src/core/systems/panel';
import type { ShotSpec } from '../src/core/gen/shot-sim';
import { FLY_ELEVATION } from '../src/core/gen/shot-sim';
import type { CourseDriver } from './course-driver';

const A = 0x0080;

export interface Replayed {
  pos: { xc: number; xf: number; yc: number; yf: number; z: number };
  holed: boolean;
  lost: boolean;
  phase: string;
}

export function replayShot(d: CourseDriver, shot: ShotSpec): Replayed {
  d.untilPhase('Aim');
  d.step(3);
  const s = d.world.get(Shot)!;
  d.world.set(Shot, {
    ...s,
    aim: ((shot.aim % 360) + 360) % 360,
    elev: shot.fly ? FLY_ELEVATION : 0,
    kind: shot.fly ? 2 : 0,
    grounder: shot.fly ? 0 : 1,
  });
  d.press(A);
  d.untilPhase('Spin');
  d.step(50);
  d.press(A);
  d.untilPhase('Power');
  d.until(() => d.t >= POWER_FIRST, 50, 'the meter');
  d.world.set(Shot, { ...d.world.get(Shot)!, meter: shot.meter, side: shot.side ?? 6, topBack: shot.topBack ?? 6 });
  d.press(A, 1);
  d.untilPhase('Rolling', 100);
  // the roll ends in RollEnd; the flow then decides holed / lost / settled
  d.until(() => d.phase !== 'Rolling', 6000, 'the end of the roll');
  const e = activePlayer(d.world);
  const lost = (e.get(BallWork)!.lost & 1) !== 0;
  const holed = e.get(BallHoled)!.holed !== 0;
  return { pos: { ...e.get(BallPos)! }, holed, lost, phase: d.phase };
}
