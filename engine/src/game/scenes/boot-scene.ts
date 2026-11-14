import Phaser from 'phaser';
import { SceneKeys } from '../scene-keys';
import type { Host, SceneData } from '../host';

/** Minimal boot (reference §7): straight to the preload scene, handing on the host. */
export class BootScene extends Phaser.Scene {
  private host!: Host;

  constructor() {
    super(SceneKeys.Boot);
  }

  init(data: SceneData): void {
    this.host = data.host;
  }

  create(): void {
    this.scene.start(SceneKeys.Preload, { host: this.host });
  }
}
