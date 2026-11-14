/**
 * Kirby and his ball (Visual 'ball'): one sprite at the point the game
 * projects him to (BallScreen, $DA56-$DA5C), playing the clip poseClip
 * names for his pose. `animate` is `sync-pose`'s part: the clip is
 * recomputed every frame and changed only when it differs (core writes Pose
 * several times a frame, not always through `set`), and restarted when the
 * pose's timer jumps up (a second hop during a hop). The ball's shadow
 * (object 121's picture) sits on the ground under an airborne ball.
 */
import Phaser from 'phaser';
import type { Entity } from 'koota';
import { Tex } from '../../assets/keys';
import { playClip } from '../../assets/atlas';
import { BallAir, BallPos, BallWork } from '../../../core/traits/ball';
import { BallScreen, Pose } from '../../../core/traits/pose';
import { Tomatoes } from '../../../core/traits/counters';
import { HoleFlow } from '../../../core/traits/flow';
import { kirbyPoint, worldOf } from '../../bridge/placement';
import type { View, ViewCtx } from '../../bridge/view';
import { KEEP, poseClip } from './pose-clips';
import { SHADOW_FRAME } from '../catalog-data';

/** What Kirby shows before core has set a pose (state 0 holds the last one): facing the camera. */
const FIRST_CLIP = 'aim_facing3';

export class KirbyView implements View {
  readonly kind = 'ball';
  readonly band = 'actor' as const;
  private readonly sprite: Phaser.GameObjects.Sprite;
  private readonly shadow: Phaser.GameObjects.Image;
  private clip: string | null = null;
  private lastTimer = 0;

  constructor(scene: Phaser.Scene) {
    this.sprite = scene.add.sprite(0, 0, Tex.atlas).setVisible(false);
    this.shadow = scene.add.image(0, 0, Tex.atlas, SHADOW_FRAME).setVisible(false);
  }

  place(ctx: ViewCtx, e: Entity): number | null {
    const p = kirbyPoint(ctx.course, e.get(BallScreen)!);
    this.sprite.setPosition(p.x, p.y);
    const hidden = ctx.hidden.has('ball');
    const flying = e.get(BallAir)!.air !== 0 && ctx.world.get(HoleFlow)!.phase === 'Rolling';
    if (flying && !hidden) {
      const pos = e.get(BallPos)!;
      const g = worldOf(ctx.course, pos.xc, pos.xf, pos.yc, pos.yf, e.get(BallWork)!.ground);
      this.shadow.setPosition(g.x, g.y).setVisible(true);
    } else {
      this.shadow.setVisible(false);
    }
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

  /** The clip playing, for the debug hook and the smoke test. */
  get current(): string | null {
    return this.clip;
  }

  get position(): { x: number; y: number; depth: number; visible: boolean } {
    return { x: this.sprite.x, y: this.sprite.y, depth: this.sprite.depth, visible: this.sprite.visible };
  }

  private show(clip: string): void {
    if (!this.sprite.scene.anims.exists(clip)) return;
    this.clip = clip;
    playClip(this.sprite, clip);
  }

  setDepth(depth: number): void {
    this.sprite.setDepth(depth);
    this.shadow.setDepth(depth - 0.0005);
  }

  destroy(): void {
    this.sprite.destroy();
    this.shadow.destroy();
  }
}
