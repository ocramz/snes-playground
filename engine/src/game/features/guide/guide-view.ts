/**
 * The shot guide while aiming (`sync-guide`): ui.json's dot and cone
 * (the game's own tiles, tools/export_web_ui.py) placed by guide-dots.ts,
 * from a small pool of images in the world. Shown in the aim stage only.
 */
import Phaser from 'phaser';
import type { World } from 'koota';
import { Tex } from '../../assets/keys';
import type { UiJson } from '../../assets/schema';
import { Guide } from '../../../core/traits/guide';
import { HoleFlow } from '../../../core/traits/flow';
import { Time } from '../../../core/traits/time';
import type { CourseState } from '../../../core/traits/course';
import { guidePictures } from './guide-dots';

export class GuideView {
  private readonly dots: Phaser.GameObjects.Image[] = [];
  private readonly cone: Phaser.GameObjects.Image | null;

  constructor(private readonly scene: Phaser.Scene, private readonly ui: UiJson | null, private readonly depth: number) {
    this.cone = ui ? scene.add.image(0, 0, Tex.ui, ui.guide.cone).setVisible(false).setDepth(depth + 0.01) : null;
  }

  update(world: World, course: CourseState): void {
    if (!this.ui || !this.cone) return;
    const show = world.get(HoleFlow)!.phase === 'Aim';
    const g = world.get(Guide)!;
    const pics = show ? guidePictures(course, g.points, g.ends, world.get(Time)!.frame) : { dots: [], cone: null };
    while (this.dots.length < pics.dots.length) {
      this.dots.push(this.scene.add.image(0, 0, Tex.ui, this.ui.guide.dot).setDepth(this.depth));
    }
    this.dots.forEach((d, i) => {
      const p = pics.dots[i];
      d.setVisible(p !== undefined);
      if (p) d.setPosition(p.x, p.y);
    });
    this.cone.setVisible(pics.cone !== null);
    if (pics.cone) this.cone.setPosition(pics.cone.x, pics.cone.y);
  }

  destroy(): void {
    for (const d of this.dots) d.destroy();
    this.cone?.destroy();
  }
}
