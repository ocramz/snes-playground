/**
 * Creates the world, then the Phaser game (reference §3: main.ts creates the
 * world, then the Phaser.Game). The world and the host context are handed
 * to the first scene in its data and passed on from scene to scene
 * (game/host.ts), never kept in a module global.
 */
import Phaser from 'phaser';
import { createGameWorld } from './core/world';
import { GAME_H, GAME_W } from './game/config';
import { SceneKeys } from './game/scene-keys';
import { readFlags, type Host } from './game/host';
import { BootScene } from './game/scenes/boot-scene';
import { PreloadScene } from './game/scenes/preload-scene';
import { MenuScene } from './game/scenes/menu-scene';
import { HoleScene } from './game/scenes/hole-scene';
import { HudScene } from './game/scenes/hud-scene';
import { ResultScene } from './game/scenes/result-scene';

const err = document.getElementById('err')!;
window.addEventListener('error', (e) => {
  err.style.display = 'grid';
  err.textContent = String(e.message);
});

const host: Host = {
  world: createGameWorld(),
  rules: null,
  assets: { atlas: null, objects: null, ui: null, hud: null, audio: null, cutscenes: null },
  sets: [],
  set: null,
  audio: null,
  flags: readFlags(window.location.search),
  screen: { hudHidden: true },
};

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
  audio: { disableWebAudio: false },
  scene: [],
});

game.scene.add(SceneKeys.Preload, PreloadScene);
game.scene.add(SceneKeys.Menu, MenuScene);
game.scene.add(SceneKeys.Hole, HoleScene);
game.scene.add(SceneKeys.Hud, HudScene);
game.scene.add(SceneKeys.Result, ResultScene);
game.scene.add(SceneKeys.Boot, BootScene, true, { host });

// Fit the canvas to the window: a whole number of pixels per game pixel when
// there is room, a fraction of one when the window is smaller than the game.
const parent = document.getElementById('game')!;
function fit(): void {
  const w = parent.clientWidth;
  const h = parent.clientHeight;
  if (w <= 0 || h <= 0) return;
  const z = Math.min(w / GAME_W, h / GAME_H);
  game.scale.setZoom(z >= 1 ? Math.floor(z) : z);
}
fit();
game.events.once(Phaser.Core.Events.READY, fit);
window.addEventListener('resize', fit);
new ResizeObserver(fit).observe(parent);
