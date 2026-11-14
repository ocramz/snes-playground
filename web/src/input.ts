import Phaser from 'phaser';
import { emptyPad, type Pad } from './sim/hole';

const MAP: Record<string, keyof Pad> = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  KeyZ: 'a', Space: 'a', Enter: 'a',
  KeyX: 'b', Escape: 'b',
  KeyC: 'y', KeyS: 'y', KeyA: 'y',
};

/**
 * Keyboard + gamepad -> the SNES pad the sim reads once per 60 Hz tick.
 * A key pressed and released between two ticks (a short tap on a slow frame)
 * still counts for one tick: presses are latched until a tick has seen them.
 */
export class PadInput {
  private down = new Set<keyof Pad>();
  private latch = new Set<keyof Pad>();
  private readonly onDown = (e: KeyboardEvent): void => {
    const b = MAP[e.code];
    if (!b) return;
    e.preventDefault();
    this.down.add(b);
    this.latch.add(b);
  };
  private readonly onUp = (e: KeyboardEvent): void => {
    const b = MAP[e.code];
    if (b) this.down.delete(b);
  };

  constructor(private readonly scene: Phaser.Scene) {
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
    scene.events.once('shutdown', () => this.destroy());
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onDown);
    window.removeEventListener('keyup', this.onUp);
  }

  /** The pad for the next tick; consumes the latched presses. */
  sample(): Pad {
    const pad = emptyPad();
    for (const b of ['left', 'right', 'up', 'down', 'a', 'b', 'y'] as (keyof Pad)[]) {
      pad[b] = this.down.has(b) || this.latch.has(b);
    }
    this.latch.clear();
    const gp = this.scene.input.gamepad?.getPad(0);
    if (gp) {
      pad.left ||= gp.left || gp.leftStick.x < -0.5;
      pad.right ||= gp.right || gp.leftStick.x > 0.5;
      pad.up ||= gp.up || gp.leftStick.y < -0.5;
      pad.down ||= gp.down || gp.leftStick.y > 0.5;
      pad.a ||= gp.A;
      pad.b ||= gp.B;
      pad.y ||= gp.Y || gp.X;
    }
    return pad;
  }
}
