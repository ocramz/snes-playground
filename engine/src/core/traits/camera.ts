import { trait } from 'koota';

/**
 * World singleton: the world camera (docs/web-demo.md "Camera"). Core
 * state, not a Phaser camera: its arrival gates the curl and it is checked
 * against the recorded `cx38`/`cy38` (plans/port_v1_koota_phaser4.md, the
 * deliberate deviation). Coordinates are the ROM's: x = $38AC is the
 * scroll's x, y = $38AE counts upward and the scroll's y is
 * `screenBase - y` ($80:BF4D; screenBase = $8B9A, 456 on hole 1).
 */
export const Camera = trait({
  /** $38AC / $38AE. */
  x: 0,
  y: 0,
  /** $38C2 / $38C4: the follow's wanted lag, -24 x Kirby's screen motion. */
  wantX: 0,
  wantY: 0,
  /** $38C6 / $38C8: the lag reached, eased toward the wanted one. */
  lagX: 0,
  lagY: 0,
  /** $39D6: the follow's state; 2 = locked on (set at every shot set-up). */
  mode: 0,
  /** $6AAA / $6AAC: the aim stage's focus, the guide's first end projected. */
  targetX: 0,
  targetY: 0,
  /** $6AB0: the last pan found the camera already on its target. */
  arrived: 0,
});
