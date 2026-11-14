// Which picture Kirby shows, as the game's own animation state `$7E:D7D4`
// (docs/animation.md). Pure TypeScript so the sequence can be tested against
// the states the real game goes through (tools/snesstep/trace_flow.py).
//
// Measured on the real game (build/web-test/flow_web_flow.json, hole 1):
//
//   aim              4 standing, 5 while Left/Right is held ($81:A804, every frame)
//   first A          the camera pans to the shot view (19-26 frames, by aim), then state 6,
//                    the curl (35 frame clip, then the ball stays); spin and power keep it
//   power A + 24     state 14 (rolling); 15 / 16 for a strong / medium spin
//   A while rolling  state 13, the hop, 17 frames, then back to 14
//   hit-stop         state 12, the squash, 4 frames, then back to 14
//   ball stops       the ball picture stays (state 14) through the 30 frames of
//                    rest and 35 more; with 1 or 2 tomatoes left state 11, tired
//                    (`$80:C7AE`); the next aim sets state 4. There is no unroll
//                    in a normal 1P hole (state 7 is not reached).

import type { Stage } from './hole';

export interface PoseCtx {
  stage: Stage;
  /** `$7E:D7C4`, 0-7 */
  facing: number;
  /** `$7E:D7CC`, 0-15 */
  angle16: number;
  /** Left or Right held in the aim stage */
  turning: boolean;
  /** hit-stop frames of a hard landing */
  frozen: boolean;
  /** squash variant for the hit-stop */
  squash: number;
  hp: number;
  side: number;
  topBack: number;
  /** frames since the A that confirmed the aim */
  shotAge: number;
  /** the camera has arrived at the shot view: Kirby curls up now */
  curlStarted: boolean;
  /** the hop clip has played to its end */
  clipFinished: boolean;
}

const nn = (n: number): string => String(n).padStart(2, '0');

export class KirbyPose {
  /** `$7E:D7D4` */
  state = 0;
  clip = '';
  /** true for one tick when the scene must restart the clip */
  restart = false;
  private curled = false;

  private enter(state: number, clip: string, force = false): void {
    if (state !== this.state || clip !== this.clip || force) this.restart = true;
    this.state = state;
    this.clip = clip;
  }

  /** The scene has started the clip. */
  started(): void { this.restart = false; }

  /** The sim entered `stage` coming from `from`. */
  onStage(stage: Stage, from: Stage, ctx: PoseCtx): void {
    switch (stage) {
      case 'aim':
        this.curled = false;
        this.enter(ctx.turning ? 5 : 4, this.aimClip(ctx));
        break;
      case 'roll': {
        if (from !== 'curl') break; // back from the cup reveal: nothing changes
        // $82:C843 / $82:C84E: by the side and top/back settings, 6 = none
        const spin = Math.max(Math.abs(ctx.side - 6), Math.abs(ctx.topBack - 6));
        if (spin >= 4) this.enter(15, 'ball_roll_spin_strong');
        else if (spin === 3) this.enter(16, 'ball_roll_spin_medium');
        else this.enter(14, 'ball_roll');
        break;
      }
      case 'rest':
        // $80:C7AE: tired and panting with one or two tomatoes left
        if (ctx.hp === 1 || ctx.hp === 2) this.enter(11, `tired_health${ctx.hp}`);
        break;
      case 'sink':
        this.enter(19, 'ball_sink');
        break;
      default:
        break;
    }
  }

  /** A pressed while rolling ($82:DAAE): state 13, back to 14 after the clip. */
  onHop(air: boolean): void {
    this.enter(13, air ? 'hop_air' : 'hop_ground', true);
  }

  tick(ctx: PoseCtx): void {
    switch (ctx.stage) {
      case 'aim': {
        // $81:A804 sets 4 or 5 every frame
        this.enter(ctx.turning ? 5 : 4, this.aimClip(ctx));
        break;
      }
      case 'spin':
      case 'power':
      case 'curl':
        if (!this.curled && ctx.curlStarted) {
          this.curled = true;
          this.enter(6, `curl_into_ball_angle${nn(ctx.angle16)}`, true);
        }
        break;
      case 'roll':
        if (ctx.frozen) {
          // $81:8CA2: state 12 for the 4 frames of hit-stop, then 14 ($81:8CD2)
          this.enter(12, `ball_squash_squash${nn(ctx.squash)}`);
        } else if (this.state === 12 || (this.state === 13 && ctx.clipFinished)) {
          this.enter(14, 'ball_roll', true);
        }
        break;
      default:
        break;
    }
  }

  private aimClip(ctx: PoseCtx): string {
    return `${ctx.turning ? 'aim_turn_facing' : 'aim_facing'}${ctx.facing}`;
  }
}
