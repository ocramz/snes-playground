/**
 * The aim stage's overlays (port_v2 phase 7): the pause menu's window and
 * cursor (`$83:AFA7`, BG3, which does not scroll: screen pixels), and the
 * look's four arrows (`$81:B908`, sprites at fixed screen points). The
 * pictures are the game's (tools/export_web.py build_pause,
 * build_look_arrows); the states come from hud-state.ts.
 */
import Phaser from 'phaser';
import { Tex } from '../../assets/keys';
import type { HudJson } from '../../assets/schema';

type Dir = 'up' | 'right' | 'down' | 'left';
const ARROW_TEX: Record<Dir, string> = { up: Tex.lookUp, right: Tex.lookRight, down: Tex.lookDown, left: Tex.lookLeft };

export class AimUiView {
  private window: Phaser.GameObjects.Image | null = null;
  private cursor: Phaser.GameObjects.Image | null = null;
  private arrows: Partial<Record<Dir, Phaser.GameObjects.Image>> = {};
  private readonly cells: Array<[number, number]>;

  constructor(scene: Phaser.Scene, hud: HudJson | null, depth: number) {
    const pause = hud?.pause;
    this.cells = pause?.cursor ?? [];
    if (pause && scene.textures.exists(Tex.pauseWindow)) {
      this.window = scene.add.image(pause.at[0], pause.at[1], Tex.pauseWindow)
        .setOrigin(0, 0).setScrollFactor(0).setDepth(depth).setVisible(false);
    }
    if (pause && scene.textures.exists(Tex.pauseCursor)) {
      this.cursor = scene.add.image(0, 0, Tex.pauseCursor)
        .setOrigin(0, 0).setScrollFactor(0).setDepth(depth + 0.1).setVisible(false);
    }
    const at = hud?.arrows;
    if (at) {
      for (const d of ['up', 'right', 'down', 'left'] as const) {
        if (!scene.textures.exists(ARROW_TEX[d])) continue;
        this.arrows[d] = scene.add.image(at[d][0], at[d][1], ARROW_TEX[d])
          .setOrigin(0, 0).setScrollFactor(0).setDepth(depth).setVisible(false);
      }
    }
  }

  update(pause: { open: boolean; cursor: number }, arrows: Record<Dir, boolean>): void {
    this.window?.setVisible(pause.open);
    if (this.cursor) {
      const cell = this.cells[pause.cursor];
      this.cursor.setVisible(pause.open && cell !== undefined);
      if (cell) this.cursor.setPosition(cell[0], cell[1]);
    }
    for (const d of ['up', 'right', 'down', 'left'] as const) this.arrows[d]?.setVisible(arrows[d]);
  }

  destroy(): void {
    this.window?.destroy();
    this.cursor?.destroy();
    for (const a of Object.values(this.arrows)) a?.destroy();
  }
}
