/**
 * Kirby and his ball (Visual 'ball'): one sprite at the point the game
 * projects him to (BallScreen, $DA56-$DA5C), playing the clip poseClip
 * names for his pose. `animate` is `sync-pose`'s part: the clip is
 * recomputed every frame and changed only when it differs (core writes Pose
 * several times a frame, not always through `set`), and restarted when the
 * pose's timer jumps up (a second hop during a hop). The ball's shadow
 * (object 121's picture) sits on the ground under an airborne ball, but not
 * in the cup (the sink's frames of web_hole have no shadow sprite), not over
 * a gap (the probe's ground is 0 there) and not once the ball is below z 0
 * ($D9D2 bit 0): `$81:A23E` hides it ($D996 = $FFFF) in those cases. While
 * the cup's rim mask is up (object 75, features/enemies/cup-mask.ts) Kirby
 * is cut off below the rim (`setCut`); in a warp his sprite is off while the
 * warp's objects take his place (features/warp).
 *
 * Kirby's OAM priority is the core's `BallSprite.prio` ($D96A, `$82:F4FD`):
 * at 3 he sorts with the other actors (sync-depth); at 1 or 2 he is behind
 * the course, under both of its layers or under the front one only
 * (sprite-rules.ts `KIRBY_DEPTH`).
 */
import Phaser from 'phaser';
import type { Entity } from 'koota';
import { Tex } from '../../assets/keys';
import { playClip } from '../../assets/atlas';
import { BallAir, BallHoled, BallPos, BallWork } from '../../../core/traits/ball';
import { BallScreen, BallSprite, Pose, PRIO_OVER } from '../../../core/traits/pose';
import { Tomatoes } from '../../../core/traits/counters';
import { HoleFlow } from '../../../core/traits/flow';
import { Warp } from '../../../core/traits/warp';
import { kirbyPoint, worldOf } from '../../bridge/placement';
import type { View, ViewCtx } from '../../bridge/view';
import { kirbyDepth, shadowShown } from './sprite-rules';
import { KEEP, poseClip } from './pose-clips';
import { SHADOW_FRAME } from '../catalog-data';
import { rowsAboveCut } from '../enemies/cup-mask';

/** What Kirby shows before core has set a pose (state 0 holds the last one): facing the camera. */
const FIRST_CLIP = 'aim_facing3';

export class KirbyView implements View {
  readonly kind = 'ball';
  readonly band = 'actor' as const;
  private readonly sprite: Phaser.GameObjects.Sprite;
  private readonly shadow: Phaser.GameObjects.Image;
  private clip: string | null = null;
  private lastTimer = 0;
  /** $D96A as of the last `place`. */
  private prio = PRIO_OVER;

  constructor(scene: Phaser.Scene) {
    this.sprite = scene.add.sprite(0, 0, Tex.atlas).setVisible(false);
    this.shadow = scene.add.image(0, 0, Tex.atlas, SHADOW_FRAME).setVisible(false);
  }

  place(ctx: ViewCtx, e: Entity): number | null {
    const p = kirbyPoint(ctx.course, e.get(BallScreen)!);
    this.sprite.setPosition(p.x, p.y);
    // the cutscene's own Kirby, or a warp's ($0B7E/$0B82, core systems/warp.ts)
    const hidden = ctx.hidden.has('ball') || ctx.world.get(Warp)!.hidden !== 0;
    const w = e.get(BallWork)!;
    const flying = e.get(BallAir)!.air !== 0 && ctx.world.get(HoleFlow)!.phase === 'Rolling'
      && e.get(BallHoled)!.holed === 0;
    if (flying && !hidden && shadowShown(w)) {
      const pos = e.get(BallPos)!;
      const g = worldOf(ctx.course, pos.xc, pos.xf, pos.yc, pos.yf, w.ground);
      this.shadow.setPosition(g.x, g.y).setVisible(true);
    } else {
      this.shadow.setVisible(false);
    }
    this.prio = e.get(BallSprite)!.prio;
    const shown = this.clip !== null && !hidden;
    this.sprite.setVisible(shown);
    return shown ? p.y : null;
  }

  animate(_ctx: ViewCtx, e: Entity): void {
    const pose = e.get(Pose)!;
    const clip = poseClip({
      state: pose.state,
      facing: pose.facing,
      angle: pose.angle,
      variant: pose.variant,
      tomatoes: e.get(Tomatoes)!.n,
      air: e.get(BallAir)!.air,
    });
    const restart = pose.timer > this.lastTimer;
    this.lastTimer = pose.timer;
    if (clip === KEEP) {
      if (this.clip === null) this.show(FIRST_CLIP);
    } else if (clip === null) {
      this.clip = null;
    } else if (clip !== this.clip || restart) {
      this.show(clip);
    }
  }

  /**
   * Hide Kirby from bitmap row `cut` down (the cup's rim), or show him whole
   * (null). Applied now, to the frame showing, and again each host frame by
   * the caller, since a clip's frames have different pivots.
   */
  setCut(cut: number | null): void {
    const s = this.sprite;
    if (cut === null) {
      if (s.isCropped) s.setCrop();
      return;
    }
    const top = s.y - s.displayOriginY;
    s.setCrop(0, 0, s.frame.width, rowsAboveCut(top, s.frame.height, cut));
  }

  /** The clip playing, for the debug hook and the smoke test. */
  get current(): string | null {
    return this.clip;
  }

  get position(): { x: number; y: number; depth: number; visible: boolean; prio: number; shadow: boolean } {
    return {
      x: this.sprite.x, y: this.sprite.y, depth: this.sprite.depth, visible: this.sprite.visible,
      prio: this.prio, shadow: this.shadow.visible,
    };
  }

  get depth(): number {
    return this.sprite.depth;
  }

  private show(clip: string): void {
    if (!this.sprite.scene.anims.exists(clip)) return;
    this.clip = clip;
    playClip(this.sprite, clip);
  }

  /** The actor band's depth at priority 3; under the course's layers at 1 or 2. */
  setDepth(depth: number): void {
    const d = kirbyDepth(this.prio, depth);
    this.sprite.setDepth(d);
    this.shadow.setDepth(d - 0.0005);
  }

  destroy(): void {
    this.sprite.destroy();
    this.shadow.destroy();
  }
}
