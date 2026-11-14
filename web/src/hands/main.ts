// hands.html: the hole putted with two hands in front of the webcam (docs/web-demo.md).
//   ?fakehands       no camera: window.__hands.set(left, right) drives the grip (e2e)
//   ?engine=tract    run the model in tract (wasm) instead of onnxruntime-web
//   ?dmin= ?dmax=    hand distance (m) for no energy and for full energy
import { createGame } from '../game';
import { BootScene } from '../scenes/BootScene';
import { TitleScene } from '../scenes/TitleScene';
import { ResultScene } from '../scenes/ResultScene';
import { HandHoleScene } from './HandHoleScene';
import { HandControl } from './control';
import { GRIP_DEFAULTS } from './gesture';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number): number => {
  const v = Number(q.get(k));
  return q.has(k) && Number.isFinite(v) ? v : d;
};

const box = document.getElementById('cam')!;
const hands = new HandControl({
  engine: q.get('engine') === 'tract' ? 'tract' : 'ort',
  fake: q.has('fakehands'),
  grip: { distMin: num('dmin', GRIP_DEFAULTS.distMin), distMax: num('dmax', GRIP_DEFAULTS.distMax) },
}, {
  box,
  canvas: document.getElementById('cam-overlay') as HTMLCanvasElement,
  status: document.getElementById('cam-status')!,
});
void hands.start();

// V shows or hides the camera inset
window.addEventListener('keydown', (e) => { if (e.code === 'KeyV') box.classList.toggle('hidden'); });

const game = createGame([BootScene, TitleScene, HandHoleScene, ResultScene]);
game.registry.set('hands', hands);
game.registry.set('help', ['TWO FISTS = AIM   APART = POWER', 'OPEN BOTH HANDS = PUTT']);
