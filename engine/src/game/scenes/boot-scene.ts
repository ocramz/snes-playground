import Phaser from 'phaser';

/** Minimal boot: straight to the preload scene (reference §8). */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot');
  }

  create(): void {
    this.scene.start('preload');
  }
}
