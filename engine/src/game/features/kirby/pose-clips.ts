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
}

/** Keep showing whatever was last shown (states 0 and 2: the script is a bare halt). */
export const KEEP = 'keep' as const;

const pad2 = (n: number): string => String(n).padStart(2, '0');

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
    default:
      return KEEP;
  }
}

/** Every pose state the 1-player engine can set (for the catalog test). */
export const ENGINE_POSE_STATES = [0, 1, 3, 4, 5, 6, 11, 12, 13, 14, 15, 16, 40, 49] as const;
