import Phaser from 'phaser';
import { GAME_H, GAME_W } from './game/config';
import { BootScene } from './game/scenes/boot-scene';
import { PreloadScene } from './game/scenes/preload-scene';

const err = document.getElementById('err')!;
window.addEventListener('error', (e) => {
  err.style.display = 'grid';
  err.textContent = String(e.message);
});

const game = new Phaser.Game({
  type: Phaser.WEBGL,
  parent: 'game',
  width: GAME_W,
  height: GAME_H,
  backgroundColor: '#0b0b14',
  pixelArt: true,
  roundPixels: true,
  antialias: false,
  scale: {
    mode: Phaser.Scale.NONE,
    zoom: 1,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  fps: { target: 60, smoothStep: false },
  scene: [BootScene, PreloadScene],
});

// Fit the canvas to the window: a whole number of pixels per game pixel when
// there is room, a fraction of one when the window is smaller than the game.
const host = document.getElementById('game')!;
function fit(): void {
  const w = host.clientWidth;
  const h = host.clientHeight;
  if (w <= 0 || h <= 0) return;
  const z = Math.min(w / GAME_W, h / GAME_H);
  game.scale.setZoom(z >= 1 ? Math.floor(z) : z);
}
fit();
game.events.once(Phaser.Core.Events.READY, fit);
window.addEventListener('resize', fit);
new ResizeObserver(fit).observe(host);
