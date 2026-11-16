/**
 * Kirby's pose -> the atlas clip that draws it (the view catalog's part for
 * the 'ball' kind; reference §12: core keeps semantic state, the view maps
 * it). Pure. The state numbers are $7E:D7D4 (traits/pose.ts PoseState and
 * build/sprites/kirby/clips/clips.json "states"); each clip's switch is the
 * variable kirbyanim found the script switching on.
 */

export interface PoseInput {
  /** $D7D4 */
  state: number;
  /** $D7C4, 0-7 */
  facing: number;
  /** $D7CC, 0-15 */
  angle: number;
  /** $6A6E, the squash variant (0-10) */
  variant: number;
  /** $D7F0: the tired clip switches on it */
  tomatoes: number;
  /** $D8A6: the hop clip switches on it */
  air: number;
  /** $D85A, the ball mode (the ability number while one is on): the transformation's clip switches on it */
  mode?: number;
  /** $D75A, the ability poses' variant */
  abilityVar?: number;
  /** $D75E, the ability poses' direction index */
  abilityDir?: number;
}

/** The copy abilities by number ($D85A; clips.json's arm names). */
export const ABILITY_NAMES = ['none', 'stone', 'parasol', 'fireball', 'needle', 'tornado', 'wheel', 'spark', 'hijump', 'freeze', 'ufo'] as const;

/** Keep showing whatever was last shown (states 0 and 2: the script is a bare halt). */
export const KEEP = 'keep' as const;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * A switch's arm, or -1 past its last: the script's switch has `arms`
 * entries and jumps through whatever follows the table beyond them.
 */
const arm = (v: number | undefined, arms: number): number => {
  const x = v ?? 0;
  return x >= 0 && x < arms ? x : -1;
};

/** An ability pose by its switches (clips.json: `var` $D75A, `dir` $D75E), KEEP off their arms. */
function abilityPose(p: PoseInput): string | typeof KEEP | null {
  const v2 = arm(p.abilityVar, 2);
  const d9 = arm(p.abilityDir, 9);
  const d16 = arm(p.abilityDir, 16);
  const varDir9 = (name: string): string | typeof KEEP => (v2 < 0 || d9 < 0 ? KEEP : `${name}_var${v2}_dir${d9}`);
  switch (p.state) {
    case 8: {
      const m = p.mode ?? 0;
      return `ability_gained_${ABILITY_NAMES[m] ?? 'none'}`;
    }
    case 20: return varDir9('stone');
    case 21: return d16 < 0 ? KEEP : `fireball_dir${pad2(d16)}`;
    case 22: return varDir9('needle');
    case 23: return varDir9('needle_alt');
    case 24: return v2 < 0 || d16 < 0 ? KEEP : `hijump_takeoff_var${v2}_dir${pad2(d16)}`;
    case 25: return d16 < 0 ? KEEP : `hijump_air_dir${pad2(d16)}`;
    case 26: return d16 < 0 ? KEEP : `wheel_start_dir${pad2(d16)}`;
    case 27: return d16 < 0 ? KEEP : `wheel_roll_dir${pad2(d16)}`;
    case 28: return 'wheel_stop';
    case 29: return 'parasol_open';
    case 30: return 'parasol_float';
    case 31: return 'parasol_pose';
    case 32: return 'tornado_start';
    case 33: return 'tornado_spin';
    case 34: return 'tornado_slow';
    case 35: return 'tornado_stop';
    case 36: return d9 < 0 ? KEEP : `freeze_dir${d9}`;
    case 37: {
      const v8 = arm(p.abilityVar, 8);
      return v8 < 0 ? KEEP : `ufo_var${v8}`;
    }
    case 38: return KEEP; // a bare halt (the UFO's end path)
    case 39: return 'ufo_end';
    case 50: return 'ball_plain';
    default: return null;
  }
}

/**
 * The clip for a pose; null hides Kirby (state 1, holed: his sprite is gone,
 * c1n 3124), KEEP leaves the current clip.
 */
export function poseClip(p: PoseInput): string | null | typeof KEEP {
  switch (p.state) {
    case 0:
    case 2:
      return KEEP;
    case 1:
      return null;
    case 3:
      // native code draws Kirby (object $BE asleep, out of tomatoes): the
      // fall-asleep clip (state 10) stands in for it — unconfirmed look
      return 'fall_asleep';
    case 4:
      return `aim_facing${p.facing & 7}`;
    case 5:
      return `aim_turn_facing${p.facing & 7}`;
    case 6:
      return `curl_into_ball_angle${pad2(p.angle & 15)}`;
    case 7:
      return `unroll_angle${pad2(p.angle & 15)}`;
    case 9:
      return `wait_turn_facing${p.facing & 7}`;
    case 10:
      return 'fall_asleep';
    case 11:
      return `tired_health${Math.max(0, Math.min(2, p.tomatoes))}`;
    case 12:
      return `ball_squash_squash${pad2(Math.max(0, Math.min(10, p.variant)))}`;
    case 13:
      return p.air !== 0 ? 'hop_air' : 'hop_ground';
    case 14:
      return 'ball_roll';
    case 15:
      return 'ball_roll_spin_strong';
    case 16:
      return 'ball_roll_spin_medium';
    case 17:
      return 'ball_roll_fast';
    case 18:
      return 'ball_roll_alt';
    case 19:
      return 'ball_sink';
    case 40:
      // $D78C = the hit code - 12; the volcano's $0F gives 3, Spark's arm
      // (clips.json: "0 Fireball, ..., 3 Spark"; the code -> $D78C step is
      // inferred from the dispatch $82:DBDE, unconfirmed)
      return 'hit_burn_spark';
    case 49:
      return 'dizzy';
    case 8:
    case 20: case 21: case 22: case 23: case 24: case 25: case 26: case 27: case 28: case 29:
    case 30: case 31: case 32: case 33: case 34: case 35: case 36: case 37: case 38: case 39:
    case 50:
      return abilityPose(p);
    default:
      return KEEP;
  }
}

/** Every pose state the 1-player engine can set (for the catalog test). */
export const ENGINE_POSE_STATES = [
  0, 1, 3, 4, 5, 6, 8, 11, 12, 13, 14, 15, 16, 19, 20, 21, 22, 24, 25, 26, 27, 28, 29, 30, 31,
  32, 33, 34, 35, 36, 37, 39, 40, 49,
] as const;
